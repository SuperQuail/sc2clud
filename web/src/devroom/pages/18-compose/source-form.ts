import { Box, Cloud, CloudDownload, FileArchive, GitBranch, Globe, HardDrive, Link2, Mountain } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SOURCE_PROVIDERS, type SourceInput, type SourceProvider } from '@/lib/api/forum';

// 下载来源（资源帖）的表单形状与校验。**为什么单独一个文件**：react-refresh 只允许组件文件导出组件
// （同文件里导出普通函数会告警），而这里的校验要能被测试直接调用 —— 与 draft.ts 同一个理由。
//
// 校验规则与后端 forum/internal/forum/sources.go 的 validSourceInput **逐条对应**：
// 这里只是把「超了会 400」提前说清，真正的信任边界仍在后端。

/** 每帖上限（后端 maxSourcesPerTopic）：界面上一排 logo 按钮，20 个已经远超「一排」 */
export const MAX_SOURCES = 20;

/** 三个长度上限都照后端来：label 按**字符数**（Go 的 []rune），size / extraction_code 按 Go 的 len()（字节） */
export const SOURCE_FIELD_MAX = { label: 60, size: 16, code: 16 } as const;

/** 站点表：key 必须与 SOURCE_PROVIDERS 完全一致（Record<SourceProvider,…> 少一个就编译不过），
 *  顺序也照它 —— 下拉的选项顺序就是这个声明顺序（source-editor.test 钉着两者一致）。
 *  图标是装饰，站点名才是认得出的那个；查不到的 provider（老库的 netdisk 等）回落到 other。 */
export const PROVIDER_SITE: Record<SourceProvider, { label: string; Icon: LucideIcon }> = {
  baidu: { label: '百度网盘', Icon: CloudDownload },
  aliyun: { label: '阿里云盘', Icon: HardDrive },
  quark: { label: '夸克网盘', Icon: Box },
  lanzou: { label: '蓝奏云', Icon: FileArchive },
  pan123: { label: '123 云盘', Icon: Box },
  weiyun: { label: '腾讯微云', Icon: Cloud },
  onedrive: { label: 'OneDrive', Icon: Cloud },
  mega: { label: 'MEGA', Icon: Mountain },
  website: { label: '官方网站', Icon: Globe },
  github: { label: 'GitHub', Icon: GitBranch },
  gitee: { label: 'Gitee', Icon: GitBranch },
  other: { label: '其他链接', Icon: Link2 },
};

/** 界面上的表单值：全是字符串（输入框给的就是字符串），提交前由 sourceBodyOf 收敛成请求体 */
export type SourceForm = {
  provider: SourceProvider;
  label: string;
  url: string;
  extraction_code: string;
  size: string;
};

/** 列表里的一条（后端 SourceDTO 的子集；provider 用 string 是故意的：老数据里有词表外的值） */
export type SourceRow = {
  id: string;
  provider: string;
  label: string;
  url: string;
  extraction_code?: string | null;
  size?: string;
  upkeep?: string;
  verified_at?: string | null;
};

/** 站点身份：词表外的 provider（老库的 netdisk）也要画得出来 —— 回落成 other 的图标 + 那个原始 key */
export function siteOf(provider: string): { label: string; Icon: LucideIcon } {
  return (PROVIDER_SITE as Record<string, { label: string; Icon: LucideIcon } | undefined>)[provider] ?? {
    ...PROVIDER_SITE.other,
    label: provider,
  };
}

/** 新表单的初值：站点默认落在 other（「其他链接」），**不落在百度网盘** ——
 *  忘了选的时候，读者看到「其他链接」只是含糊；看到一颗百度 logo 却是**错的**。
 *  也不按链接域名自动猜：改链接时把用户已经选好的站点顶掉，比手选更糟。 */
export function emptyForm(): SourceForm {
  return { provider: 'other', label: '', url: '', extraction_code: '', size: '' };
}

/** 已有的一条 → 表单初值（url 就是服务端存的原始链接，编辑要能看到它） */
export function formOf(row: SourceRow): SourceForm {
  return {
    provider: row.provider as SourceProvider,
    label: row.label,
    url: row.url,
    extraction_code: row.extraction_code ?? '',
    size: row.size ?? '',
  };
}

const ALNUM = /^[0-9A-Za-z]+$/;

/** 提交前的本地校验：返回空对象 = 可提交。键名是**后端的 JSON 字段名**，
 *  所以后端 400 回来的 fields 能直接并进同一张表显示。 */
export function sourceFieldErrors(form: SourceForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (!(SOURCE_PROVIDERS as readonly string[]).includes(form.provider)) e.provider = '不是已知的下载源站点';
  const url = form.url.trim();
  if (url === '') e.url = '不能为空';
  else if (!url.startsWith('http://') && !url.startsWith('https://')) e.url = '必须是 http(s) 链接';
  const label = form.label.trim();
  if ([...label].length > SOURCE_FIELD_MAX.label) e.label = '长度不能超过 ' + SOURCE_FIELD_MAX.label;
  const size = form.size.trim();
  if (new TextEncoder().encode(size).length > SOURCE_FIELD_MAX.size) e.size = '长度不能超过 ' + SOURCE_FIELD_MAX.size;
  const code = form.extraction_code.trim();
  if (code !== '' && (new TextEncoder().encode(code).length > SOURCE_FIELD_MAX.code || !ALNUM.test(code))) {
    e.extraction_code = '只能是 16 位以内的字母数字';
  }
  return e;
}

/** 表单 → 请求体（trim 与「空提取码 = null」在后端也是这么做的，这里只是别把空格发过去） */
export function sourceBodyOf(form: SourceForm): SourceInput {
  const code = form.extraction_code.trim();
  return {
    provider: form.provider,
    url: form.url.trim(),
    label: form.label.trim(),
    extraction_code: code === '' ? null : code,
    size: form.size.trim(),
  };
}
