import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// dev 制品：**唯一**的打包入口。顺序与自检都固化在这里，不靠人记。
//   node scripts/pack-dev.ts <git-sha>        （在 web/ 下运行）
// 为什么必须是一个程序：手工命令出过三次事故——跳过构建、dist 被清空、新页没进产物。
const web = process.cwd();
const repo = resolve(web, '..');
const sha = process.argv[2] ?? 'dev';
const out = join(repo, '.tools', 'out');
const goBin = process.env.GO_BIN ?? 'go';

function run(label: string, cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  process.stdout.write('· ' + label + ' … ');
  const r = spawnSync(cmd, args, { cwd, stdio: 'pipe', shell: true, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('失败');
    console.error((r.stdout ?? '') + (r.stderr ?? ''));
    process.exit(r.status ?? 1);
  }
  console.log('ok');
}

function assert(ok: boolean, msg: string) {
  if (!ok) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
}

run('产品构建（带 dev 入口）', 'pnpm', ['build'], web, { VITE_DEVROOM: '1' });
run('DevRoom 构建', 'pnpm', ['preview:build'], web);

// DevRoom 作为子应用塞进 dist —— **必须在最后一次构建之后**，build 会清空 dist
const devDir = join(web, 'dist', 'devroom');
rmSync(devDir, { recursive: true, force: true });
mkdirSync(devDir, { recursive: true });
cpSync(join(web, 'preview-dist'), devDir, { recursive: true });
renameSync(join(devDir, 'devroom.html'), join(devDir, 'index.html'));
assert(existsSync(join(devDir, 'index.html')), 'DevRoom 没进 dist/devroom');
console.log('· DevRoom 已并入 dist/devroom');

run('产物自洽门禁', 'node', ['scripts/check-bundle.ts'], web);

mkdirSync(out, { recursive: true });
run('Go 编译 (linux/amd64)', goBin,
  ['build', '-trimpath', '-ldflags', '-s -w -X main.version=' + sha, '-o', join(out, 'forum'), './cmd/forum'],
  join(repo, 'forum'),
  { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
);

const stage = join(out, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
cpSync(join(out, 'forum'), join(stage, 'bin', 'forum'));
cpSync(join(web, 'dist'), join(stage, 'dist'), { recursive: true });
const pkg = join(out, 'forum-' + sha + '-dev.tar.gz');
run('打包', 'tar', ['-czf', pkg, 'bin', 'dist'], stage);

// 回读校验：包内容不对就不许部署
const listing = spawnSync('tar', ['-tzf', pkg], { encoding: 'utf8', shell: true }).stdout ?? '';
for (const must of ['bin/forum', 'dist/index.html', 'dist/devroom/index.html']) {
  assert(listing.includes(must), '包内缺少 ' + must);
}
const devCount = listing.split('\n').filter((l) => l.includes('dist/devroom/')).length;
assert(devCount > 5, '包内 DevRoom 条目太少（' + devCount + '）');
const size = Math.round((statSync(pkg).size / 1048576) * 100) / 100;
console.log('✓ 已打包 forum-' + sha + '-dev.tar.gz  ' + size + 'MB  DevRoom 条目 ' + devCount);
