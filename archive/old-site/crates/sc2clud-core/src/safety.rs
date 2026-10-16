//! 路径安全校验。
//!
//! 本模块是**所有写 / 删 / 读路径的唯一闸门**，沿用既有项目 HSCL
//! (`crates/miyin-core/src/safety.rs`) 的模式。网盘场景下用户可控的文件名、
//! 分片序号、秒传哈希都可能构造出 `..`、绝对路径与符号链接越界，
//! 因此任何落盘路径在拼接之后都必须先经过 [`ensure_within`]。
//!
//! 两道防线：
//! 1. [`lexical_normalize`] / [`resolve`]：规范化并解析符号链接与 junction；
//! 2. [`ensure_within`] / [`ensure_within_any`]：按**路径组件**判定是否越界。

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// 文件名单段长度上限（字节）。ext4 单段上限 255，这里留出后缀余量。
pub const MAX_FILE_NAME_LEN: usize = 200;

/// Windows 保留设备名（大小写不敏感，带扩展名同样保留）。
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 词法规范化：消除 `.` 与 `..`，**不访问文件系统**。
///
/// 无法回退的 `..`（例如根目录之上）会被原样保留，从而在校验阶段暴露为越界。
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                } else {
                    out.push(Component::ParentDir.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 把路径解析为「尽量贴近真实的绝对路径」。
///
/// 与 [`std::fs::canonicalize`] 不同，本函数允许路径本身（及其尾部组件）尚不存在：
/// 它会向上寻找最近的**已存在**祖先并对其 `canonicalize`（顺带解析符号链接与
/// junction），再把剩余组件拼回，最后做词法规范化。这样「按需创建」的分片目录
/// 也能被安全校验。
pub fn resolve(path: &Path) -> Result<PathBuf> {
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut cursor = path;

    while !cursor.exists() {
        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                cursor = parent;
            }
            // 已到根（如 C:\）仍然不存在，交给 canonicalize 报错
            _ => break,
        }
    }

    let mut base = cursor.canonicalize()?;
    for name in tail.iter().rev() {
        base.push(name);
    }
    Ok(strip_verbatim(lexical_normalize(&base)))
}

/// 去掉 Windows 上 canonicalize 产生的逐字（verbatim）前缀，
/// 否则日志与配置里会出现难以阅读、且部分 API 不接受的形式。
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(stripped) = strip_verbatim_windows(&path) {
        return stripped;
    }
    path
}

#[cfg(windows)]
fn strip_verbatim_windows(path: &Path) -> Option<PathBuf> {
    use std::path::Prefix;

    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(disk) => {
                let mut out = PathBuf::from(format!("{}:\\", disk as char));
                out.push(components.as_path());
                Some(out)
            }
            _ => None,
        },
        _ => None,
    }
}

/// 校验 `target` 是否落在 `root` 之内（含 `root` 自身），并返回解析后的绝对路径。
///
/// 比较**按路径组件**进行，因此 `a/bc` 不会被误判为 `a/b` 的子路径。
pub fn ensure_within(root: &Path, target: &Path) -> Result<PathBuf> {
    let root = resolve(root)?;
    let target = resolve(target)?;
    if target == root || target.starts_with(&root) {
        Ok(target)
    } else {
        Err(Error::PathEscapesRoot { root, target })
    }
}

/// 校验 `target` 是否落在**任意一个**白名单根目录内。
///
/// 尚不存在的根目录会被跳过——它不可能包含一个已存在的目标。
pub fn ensure_within_any<'a, I>(roots: I, target: &Path) -> Result<PathBuf>
where
    I: IntoIterator<Item = &'a Path>,
{
    let target_resolved = resolve(target)?;
    let mut last_root: Option<PathBuf> = None;

    for root in roots {
        if !root.exists() {
            continue;
        }
        let root_resolved = resolve(root)?;
        if target_resolved == root_resolved || target_resolved.starts_with(&root_resolved) {
            return Ok(target_resolved);
        }
        last_root = Some(root_resolved);
    }

    Err(Error::PathEscapesRoot {
        root: last_root.unwrap_or_else(|| PathBuf::from("(无)")),
        target: target_resolved,
    })
}

/// 校验用户提供的文件名：**只做语法校验，不落盘**。
///
/// 通过校验的名字仍然只是一个名字；拼接完整路径后必须再走 [`ensure_within`]。
pub fn safe_file_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    let reject = |reason: &'static str| Error::IllegalFileName {
        name: name.to_string(),
        reason,
    };

    if trimmed.is_empty() {
        return Err(reject("文件名为空"));
    }
    if trimmed.len() > MAX_FILE_NAME_LEN {
        return Err(reject("文件名过长"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(reject("文件名不能是 . 或 .."));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(reject("包含控制字符"));
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(reject("包含路径分隔符或保留字符"));
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err(reject("以点或空格结尾"));
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        return Err(reject("Windows 保留设备名"));
    }
    Ok(trimmed.to_string())
}

/// 把任意字符串压成可用的安全文件名；无法修复的字符替换为 `_`，极端情况退化为 `unnamed`。
pub fn sanitize_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len().min(MAX_FILE_NAME_LEN));
    for ch in name.trim().chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.chars().count() > MAX_FILE_NAME_LEN {
        out = out.chars().take(MAX_FILE_NAME_LEN).collect();
    }
    if out.is_empty() || out == "." || out == ".." {
        return "unnamed".to_string();
    }
    let stem = out.split('.').next().unwrap_or(&out).to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        out.insert(0, '_');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_normalize_removes_dot_and_parent() {
        assert_eq!(
            lexical_normalize(Path::new("a/./b/../c")),
            PathBuf::from("a/c")
        );
    }

    #[test]
    fn lexical_normalize_keeps_unresolvable_parent() {
        assert_eq!(lexical_normalize(Path::new("../a")), PathBuf::from("../a"));
    }

    #[test]
    fn ensure_within_accepts_nested_not_yet_existing_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("blobs");
        let target = root.join("ab").join("cd").join("x");
        let resolved = ensure_within(&root, &target).expect("应判定为在根目录内");
        assert!(resolved.ends_with("ab/cd/x") || resolved.ends_with("ab\\cd\\x"));
    }

    #[test]
    fn ensure_within_rejects_parent_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("blobs");
        std::fs::create_dir_all(&root).expect("create root");
        let target = root.join("..").join("evil");
        let err = ensure_within(&root, &target).expect_err("越界路径必须被拒绝");
        assert!(matches!(err, Error::PathEscapesRoot { .. }));
    }

    #[test]
    fn ensure_within_rejects_sibling_with_shared_prefix() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = tmp.path().join("a");
        let root = base.join("b");
        let sibling = base.join("bc");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&sibling).expect("create sibling");
        assert!(ensure_within(&root, &sibling).is_err());
    }

    #[test]
    fn safe_file_name_rules() {
        assert_eq!(safe_file_name(" 地图包.zip ").expect("ok"), "地图包.zip");
        assert!(safe_file_name("a/b").is_err());
        assert!(safe_file_name("a\\b").is_err());
        assert!(safe_file_name("..").is_err());
        assert!(safe_file_name("").is_err());
        assert!(safe_file_name("CON.txt").is_err());
        assert!(safe_file_name("trailing.").is_err());
    }

    #[test]
    fn sanitize_rewrites_dangerous_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("   "), "unnamed");
        assert_eq!(sanitize_file_name("a\u{0}b"), "a_b");
    }
}
