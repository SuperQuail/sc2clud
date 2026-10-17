import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 接线门禁：**后端有端点 ≠ 前端调用过**。
// 来历（2026-10-16 三条同形缺陷）：D72 撤头衔、D73 置顶/精华、D80 编辑稿送审 ——
// 路由、service、后端测试全在，界面上没有任何一处会调它，pnpm check 全绿。
// 这条门禁把两侧的真源摊开对账：
//   真源 A：forum/internal/**/handler.go 的 X.GET("/path") 一族（含同文件 Group("/p") 前缀）
//   真源 B：web/src/lib/api/**/*.ts 的 api()/apiPage()/apiEnvelope() 第一参数
// 孤儿端点（A 有 B 无）按域分组 + 建议落地屏；幽灵路径（B 有 A 无）直接红。
// shortcut: 只对账路径、不校验方法（第二参数的 method 有三元表达式），--page 是模块粒度；
//           升级时机：真出现「路径对了但方法错了」或「导入了模块却没调」的缺陷时再往下钻。

export type Route = { method: string; path: string; file: string; line: number; domain: string };
export type Call = { pattern: string; file: string; line: number };
export type Indirect = { file: string; line: number; raw: string };
export type Baseline = { routes: Array<{ route: string; reason: string }>; ghosts: Array<{ pattern: string; reason: string }> };

// 不写 new URL('..', import.meta.url)：vite 会把这种形状改写成 dev server 的 http 地址，
// 被 vitest 导入时 fileURLToPath 直接抛「scheme 不是 file」（本文件有单测，必须两种运行时都能取到目录）。
const WEB = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(WEB, '..');
const FORUM = join(REPO, 'forum', 'internal');
const API = join(WEB, 'src', 'lib', 'api');
const BASELINE = join(WEB, 'scripts', 'wiring-baseline.json');

// ── 真源 A：路由表 ────────────────────────────────────────────────────────────

const GROUP_LINE = /^\s*([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.Group\(\s*(['"])([^'"]*)\3/;
const ROUTE_LINE = /([A-Za-z_]\w*)\.(GET|POST|PUT|PATCH|DELETE)\(\s*(['"])([^'"]*)\3/;

function joinPath(a: string, b: string): string {
  const left = a.replace(/\/+$/, '');
  const right = b.replace(/^\/+/, '');
  // 空 path 的 Group（如 tpl.GET("", …) 挂在 /admin/mail-templates 上）不能留尾斜杠
  const out = (left + '/' + right).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return out === '' ? '/' : out;
}

/** 一个 handler.go 里的全部路由；同文件里 g := rg.Group("/messages") 的前缀会被带上。 */
export function extractRoutes(text: string, file: string): Route[] {
  const out: Route[] = [];
  const prefix = new Map<string, string>([['rg', '']]);
  const domain = relative(FORUM, file).split(/[\\/]/)[0] ?? '';
  text.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//')) return; // 整行注释：文档里全是示例路由
    const g = GROUP_LINE.exec(line);
    if (g) {
      prefix.set(g[1]!, joinPath(prefix.get(g[2]!) ?? '', g[4]!));
      return;
    }
    const m = ROUTE_LINE.exec(line);
    if (!m) return;
    const known = prefix.get(m[1]!);
    const path = known === undefined ? m[4]! : joinPath(known, m[4]!);
    out.push({ method: m[2]!, path, file: relative(REPO, file).split(/[\\/]/).join('/'), line: i + 1, domain });
  });
  return out;
}

// ── 真源 B：前端 api() 调用 ───────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** 表达式 → 候选模式：字符串字面量保留，encodeURIComponent(x) / 标识符 → .* */
export function exprToPattern(expr: string): string | null {
  const source = expr.trim();
  if (source === '') return null;
  let out = '';
  for (const piece of splitPlus(source)) out += fragment(piece.trim());
  return out === '' ? null : out;
}

function fragment(t: string): string {
  const q = t[0];
  if ((q === "'" || q === '"') && t.length >= 2 && t.endsWith(q)) return t.slice(1, -1);
  if (q === '\x60' && t.endsWith('\x60')) return t.slice(1, -1).replace(/\$\{[^}]*\}/g, '.*');
  return '.*';
}

/** 按顶层 + 拆（括号里、字符串里的 + 不算）。 */
function splitPlus(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === '\x60') {
      i = skipString(src, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '+' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function skipString(src: string, at: number): number {
  const quote = src[at]!;
  let i = at + 1;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i + 1;
    else i++;
  }
  return i;
}

/** 本文件里 const X = '...' 的初始化表达式（单行）。非路径字面量返回 null。 */
function constInit(text: string, name: string): string | null {
  const re = new RegExp('(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+' + name + '[ \\t]*=[ \\t]*');
  const m = re.exec(text);
  if (!m) return null;
  const init = (text.slice(m.index + m[0].length).split('\n')[0] ?? '').replace(/;\s*$/, '').trim();
  // 只认「拼出来的路径字面量」：别的（函数调用、形参）算间接，不编一个假候选出来
  return /^['"\x60]/.test(init) ? init : null;
}

export function extractCalls(text: string, file: string): { calls: Call[]; indirect: Indirect[] } {
  const calls: Call[] = [];
  const indirect: Indirect[] = [];
  const rel = relative(REPO, file).split(/[\\/]/).join('/');
  for (const m of text.matchAll(/(?<![\w.])(apiEnvelope|apiPage|api)\s*/g)) {
    const at = m.index;
    const line = text.slice(0, at).split('\n').length;
    if (/\bfunction$/.test(text.slice(0, at).trimEnd())) continue; // 定义行（export async function api<T>(path…)）
    // 注释里的 api('…') 是文档举例，不是接线（lib/api 满篇都在注释里点名端点）
    const lineBefore = text.slice(text.lastIndexOf('\n', at) + 1, at);
    if (lineBefore.includes('//') || /^\s*\*/.test(lineBefore)) continue;
    let i = at + m[0].length;
    if (text[i] === '<') {
      const end = skipAngles(text, i);
      if (end < 0) continue;
      i = end;
    }
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== '(') continue;
    const arg = firstArg(text, i);
    if (arg === null) continue;
    const expr = arg.trim();
    if (expr === '') continue;
    if (IDENT.test(expr)) {
      const init = constInit(text, expr);
      const pattern = init === null ? null : exprToPattern(init);
      if (pattern === null) {
        indirect.push({ file: rel, line, raw: expr });
        continue;
      }
      calls.push({ pattern, file: rel, line });
      continue;
    }
    const pattern = exprToPattern(expr);
    if (pattern !== null) calls.push({ pattern, file: rel, line });
  }
  return { calls, indirect };
}

// shortcut: 泛型实参按 <> 配平，类型里出现 => 会把配对算错（当前代码没有）；出现箭头函数类型时改用 TS 解析器
function skipAngles(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (src[i] === '\n') return -1;
  }
  return -1;
}

function firstArg(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"' || c === '\x60') {
      i = skipString(src, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    } else if (c === ',' && depth === 1) return src.slice(open + 1, i);
  }
  return null;
}

// ── 对账 ─────────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[$^*+?.()|[\]{}]/g, '\\$&');
const strip = (p: string) => p.replace(/^\/+|\/+$/g, '');

/** 路由模板 → regex：:param 当 [^/]+。用它测候选模式串（候选的 .* 恰好是两个非斜杠字符）。 */
export function routeRegex(path: string): RegExp {
  const body = strip(path)
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (s.startsWith(':') ? '[^/]+' : escapeRe(s)))
    .join('/');
  return new RegExp('^' + body + '$');
}

export function isWired(route: Route, calls: Call[]): boolean {
  const re = routeRegex(route.path);
  return calls.some((c) => re.test(strip(c.pattern)));
}

export function isGhost(pattern: string, routes: Route[]): boolean {
  const target = strip(pattern);
  return !routes.some((r) => routeRegex(r.path).test(target));
}

/** 静态映射表：孤儿端点该落在哪一屏（未知给 <待定>，供 Lead 排修复时定位）。 */
const SCREENS: Array<[RegExp, string]> = [
  [/^\/healthz/, '（探针，无界面）'],
  [/^\/admin\/users(\/|$)/, 'web/src/routes/admin/users.tsx'],
  [/^\/admin\/(boards|groups)/, 'web/src/routes/admin/boards.tsx'],
  [/^\/admin\/mail\/accounts/, 'web/src/routes/admin/mail.tsx'],
  [/^\/admin\/mail-templates/, 'web/src/routes/admin/mail-tpl.tsx'],
  [/^\/admin\/ai/, 'web/src/routes/admin/ai.tsx'],
  [/^\/admin\/topics/, 'web/src/routes/admin/review.tsx'],
  [/^\/admin\/(reports|appeals)/, 'web/src/routes/admin/reports.tsx'],
  [/^\/admin\/issues/, 'web/src/routes/admin/review.tsx'],
  [/^\/admin\/rewards/, 'web/src/routes/admin/rewards.tsx'],
  [/^\/admin\/(roles|permissions)/, 'web/src/routes/admin/roles.tsx'],
  [/^\/admin\/(site-settings|site-domains|announcements|banners|donation-notice-defaults|titles)/, 'web/src/routes/admin/settings.tsx'],
  [/^\/admin\/audit-logs/, 'web/src/routes/admin/audit.tsx'],
  [/^\/admin\/diagnostics/, 'web/src/routes/admin/diagnostics.tsx'],
  [/^\/admin\/launcher/, 'web/src/routes/admin.tsx（下载源管理）'],
  [/^\/admin\//, '<待定>'],
  [/^\/topics\/[^/]+\/(pin|feature)/, 'web/src/routes/topic.tsx'],
  [/^\/topics/, 'web/src/routes/topic.tsx'],
  [/^\/issues/, 'web/src/routes/issues.tsx'],
  [/^\/issue-comments/, 'web/src/routes/issues.tsx'],
  [/^\/posts/, 'web/src/routes/topic.tsx'],
  [/^\/boards/, 'web/src/routes/board.tsx'],
  [/^\/users/, 'web/src/routes/profile.tsx'],
  [/^\/me/, 'web/src/routes/settings.tsx'],
  [/^\/messages/, 'web/src/routes/messages.tsx'],
  [/^\/notifications/, 'web/src/routes/notifications.tsx'],
  [/^\/appeals|^\/reports/, 'web/src/routes/appeal.tsx'],
  [/^\/titles/, 'web/src/routes/settings.tsx'],
  [/^\/rewards/, 'web/src/routes/me.tsx'],
  [/^\/launcher/, 'web/src/routes/download.tsx'],
  [/^\/site|^\/banners|^\/markdown/, 'web/src/routes/home.tsx'],
  [/^\/search/, 'web/src/routes/home.tsx'],
  [/^\/auth|^\/captcha/, 'web/src/routes/login.tsx'],
];

export function suggestScreen(path: string): string {
  for (const [re, screen] of SCREENS) if (re.test(path)) return screen;
  return '<待定>';
}

/** 基线校验：缺 reason / 过期条目一律报出来（基线不许腐烂）。 */
export function checkBaseline(
  base: Baseline,
  routes: Route[],
  orphans: Route[],
  ghosts: Call[],
): { problems: string[]; keptOrphans: Route[]; keptGhosts: Call[] } {
  const problems: string[] = [];
  const current = new Set(routes.map((r) => r.method + ' ' + r.path));
  const orphanKeys = new Set(orphans.map((r) => r.method + ' ' + r.path));
  const ghostKeys = new Set(ghosts.map((c) => c.pattern));
  const keptOrphans: Route[] = [];
  const keptGhosts: Call[] = [];

  for (const e of base.routes) {
    if (e.reason.trim() === '') problems.push('基线条目缺 reason：' + e.route + '（基线不是垃圾桶）');
    if (!current.has(e.route)) problems.push('过期条目：路由 ' + e.route + ' 已经不存在了，请删掉');
    else if (!orphanKeys.has(e.route)) problems.push('过期条目：路由 ' + e.route + ' 已经被前端调用，请删掉');
    else keptOrphans.push(orphans.find((r) => r.method + ' ' + r.path === e.route)!);
  }
  for (const e of base.ghosts) {
    if (e.reason.trim() === '') problems.push('基线条目缺 reason：ghost ' + e.pattern + '（基线不是垃圾桶）');
    if (!ghostKeys.has(e.pattern)) problems.push('过期条目：幽灵 ' + e.pattern + ' 已经消失或已被路由接住，请删掉');
    else keptGhosts.push(ghosts.find((c) => c.pattern === e.pattern)!);
  }
  return { problems, keptOrphans, keptGhosts };
}

// ── 采集 ─────────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue; // .embedded-postgres-go 之类的构建缓存
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function collectRoutes(): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const file of walk(FORUM).filter((f) => f.endsWith('handler.go'))) {
    for (const r of extractRoutes(readFileSync(file, 'utf8'), file)) {
      const key = r.method + ' ' + r.path;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => (a.path + ' ' + a.method < b.path + ' ' + b.method ? -1 : 1));
}

/** 前端调用点：**不扫 *.test.ts** —— 测试里的 '/me'、'/healthz' 是造出来的请求，不是接线。 */
export function collectCalls(): { calls: Call[]; indirect: Indirect[] } {
  const calls: Call[] = [];
  const indirect: Indirect[] = [];
  for (const file of walk(API).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const got = extractCalls(readFileSync(file, 'utf8'), file);
    calls.push(...got.calls);
    indirect.push(...got.indirect);
  }
  return { calls, indirect };
}

// ── 单页模式 ─────────────────────────────────────────────────────────────────

function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(WEB, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const cand of [base, base + '.ts', base + '.tsx', base + '.js', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 该页（及其一跳 import 模块）里出现的候选端点。 */
export function pageScope(pageFile: string): { scope: string[]; calls: Call[]; indirect: Indirect[] } {
  const scope = [pageFile];
  const text = readFileSync(pageFile, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const mod = resolveModule(pageFile, m[1]!);
    if (mod !== null && !scope.includes(mod)) scope.push(mod);
  }
  const calls: Call[] = [];
  const indirect: Indirect[] = [];
  for (const f of scope) {
    if (!/\.tsx?$/.test(f)) continue;
    const got = extractCalls(readFileSync(f, 'utf8'), f);
    calls.push(...got.calls);
    indirect.push(...got.indirect);
  }
  return { scope, calls, indirect };
}

function locate(arg: string): string {
  for (const cand of [resolve(arg), join(REPO, arg), join(WEB, arg)]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error('找不到页面文件：' + arg);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { routes: [], ghosts: [] };
  const raw = JSON.parse(readFileSync(BASELINE, 'utf8')) as Partial<Baseline>;
  return { routes: raw.routes ?? [], ghosts: raw.ghosts ?? [] };
}

function writeBaseline(routes: Route[], ghosts: Call[], base: Baseline, report: (s: string) => void): void {
  const reasonOf = new Map(base.routes.map((e) => [e.route, e.reason]));
  const ghostReason = new Map(base.ghosts.map((e) => [e.pattern, e.reason]));
  const todos: string[] = [];
  const reason = (key: string, known: string | undefined): string => {
    if (known !== undefined && known.trim() !== '') return known;
    todos.push(key);
    return 'TODO';
  };
  const out = {
    routes: routes.map((r) => ({ route: r.method + ' ' + r.path, reason: reason(r.method + ' ' + r.path, reasonOf.get(r.method + ' ' + r.path)) })),
    ghosts: [...new Set(ghosts.map((c) => c.pattern))].sort().map((p) => ({ pattern: p, reason: reason('ghost ' + p, ghostReason.get(p)) })),
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  report('基线已重写：' + BASELINE);
  for (const t of todos) report('  ! ' + t + ' 的 reason 还是 TODO —— 逐条补上「为什么它现在没有前端调用」');
}

function main(): void {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const asJson = args.includes('--json');
  const say = (s: string) => {
    if (!asJson) console.log(s);
  };
  const rel = (f: string) => relative(REPO, f).split(/[\\/]/).join('/');

  const routes = collectRoutes();

  if (args.includes('--page')) {
    const page = locate(opt('--page') ?? '');
    const { scope, calls, indirect } = pageScope(page);
    const wired = routes.filter((r) => isWired(r, calls)).map((r) => r.method + ' ' + r.path);
    const expect = (opt('--expect') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    const missing = expect.filter((e) => !wired.includes(e));
    const extra = wired.filter((k) => !expect.includes(k));
    if (asJson) console.log(JSON.stringify({ page: rel(page), scope: scope.map(rel), wired, missing, extra, indirect }, null, 2));
    else {
      say('这一页接线的端点（' + wired.length + ' 条）：' + rel(page));
      for (const f of scope.slice(1)) say('  一跳 import：' + rel(f));
      for (const k of wired) say('  ✓ ' + k);
      if (indirect.length > 0) say('  间接（首参不是字面量，未计入）：' + indirect.map((x) => x.file + ':' + x.line).join('、'));
      if (expect.length > 0) {
        say('期望 ' + expect.length + ' 条 / 完全相符 ' + wired.filter((k) => expect.includes(k)).length + ' 条');
        for (const k of missing) console.error('失败：期望接线但没接上：' + k);
        for (const k of extra) console.log('警告：接线了但不在期望里：' + k);
      }
    }
    if (missing.length > 0) process.exit(1);
    return;
  }

  const { calls, indirect } = collectCalls();
  const orphans = routes.filter((r) => !isWired(r, calls));
  const ghostSites = calls.filter((c) => isGhost(c.pattern, routes));
  const ghosts = [...new Set(ghostSites.map((c) => c.pattern))].map((p) => ghostSites.find((c) => c.pattern === p)!);
  const base = loadBaseline();

  if (args.includes('--update')) {
    writeBaseline(orphans, ghosts, base, say);
    return;
  }

  const { problems, keptOrphans, keptGhosts } = checkBaseline(base, routes, orphans, ghosts);
  const exempt = new Set(keptOrphans.map((r) => r.method + ' ' + r.path));
  const ghostExempt = new Set(keptGhosts.map((c) => c.pattern));
  const unlistedOrphans = orphans.filter((r) => !exempt.has(r.method + ' ' + r.path));
  const unlistedGhosts = ghosts.filter((c) => !ghostExempt.has(c.pattern));
  const stats = {
    routes: routes.length,
    wired: routes.length - orphans.length,
    orphans: orphans.length,
    exempt: keptOrphans.length,
    ghosts: ghosts.length,
    ghostsExempt: keptGhosts.length,
    indirect: indirect.length,
  };

  if (asJson) {
    console.log(JSON.stringify({
      stats,
      orphans: orphans.map((r) => ({ route: r.method + ' ' + r.path, file: r.file + ':' + r.line, domain: r.domain, screen: suggestScreen(r.path), baseline: exempt.has(r.method + ' ' + r.path) })),
      ghosts: ghosts.map((c) => ({ pattern: c.pattern, file: c.file + ':' + c.line, baseline: ghostExempt.has(c.pattern) })),
      indirect,
      problems,
    }, null, 2));
  } else {
    say('后端路由 ' + stats.routes + ' 条：已接线 ' + stats.wired + '、基线豁免 ' + stats.exempt + '、孤儿 ' + stats.orphans + '；前端幽灵路径 ' + stats.ghosts + ' 条（基线 ' + stats.ghostsExempt + '）；间接调用 ' + stats.indirect + ' 处');
    if (orphans.length > 0) {
      const byDomain = new Map<string, Route[]>();
      for (const r of orphans) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
      say('');
      say('孤儿端点（后端有、前端零调用）—— 按域分组：');
      for (const [domain, list] of [...byDomain].sort()) {
        say('  [' + domain + '] ' + list.length + ' 条');
        for (const r of list) {
          say('    ' + (r.method + ' ' + r.path).padEnd(46) + r.file + ':' + r.line + '  → ' + suggestScreen(r.path) + (exempt.has(r.method + ' ' + r.path) ? '（基线豁免）' : ''));
        }
      }
    }
    if (ghosts.length > 0) {
      say('');
      say('幽灵路径（前端调用、后端无此路由）：');
      for (const c of ghosts) say('  ' + c.pattern.padEnd(46) + c.file + ':' + c.line + (ghostExempt.has(c.pattern) ? '（基线豁免）' : ''));
    }
    if (indirect.length > 0) {
      say('');
      say('间接调用（首参不是字面量，无法对账，只计数）：');
      for (const x of indirect) say('  ' + x.file + ':' + x.line + '  ' + x.raw);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error('失败：' + p);
    console.error('跑 node scripts/check-wiring.ts --update 可以友好地重写基线（每条都要 reason）');
    process.exit(1);
  }
  if (unlistedOrphans.length > 0 || unlistedGhosts.length > 0) {
    for (const r of unlistedOrphans) console.error('失败：孤儿端点没进基线：' + r.method + ' ' + r.path + '（' + r.file + ':' + r.line + '，建议落地屏 ' + suggestScreen(r.path) + '）');
    for (const c of unlistedGhosts) console.error('失败：幽灵路径没进基线：' + c.pattern + '（' + c.file + ':' + c.line + '）');
    console.error('确认过每一条之后跑 node scripts/check-wiring.ts --update（重写前请给每条写 reason）');
    process.exit(1);
  }
  say('接线门禁通过');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
