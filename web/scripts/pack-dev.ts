import { cpSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// dev 制品打包：node scripts/pack-dev.ts [git-sha]
// **顺序不能变**：产品构建会清空 dist（emptyOutDir），所以 devroom 必须在最后一次构建之后再塞进去。
// 之前手工塞过再跑 pnpm check（内含 build）→ dist/devroom 被抹掉 → /dev/devroom/ 掉进 SPA 回退变 404。
const root = process.cwd();
const sha = process.argv[2] ?? 'dev';
const run = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('pnpm', ['build'], { VITE_DEVROOM: '/dev/devroom/' });
run('pnpm', ['preview:build']);

const devroom = join(root, 'dist', 'devroom');
rmSync(devroom, { recursive: true, force: true });
mkdirSync(devroom, { recursive: true });
cpSync(join(root, 'preview-dist'), devroom, { recursive: true });
renameSync(join(devroom, 'devroom.html'), join(devroom, 'index.html'));
if (!existsSync(join(devroom, 'index.html'))) throw new Error('devroom 没进 dist');

const out = join(root, '..', '.tools', 'out');
mkdirSync(out, { recursive: true });
run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${sha}`, '-o', join(out, 'forum'), './cmd/forum'], {
  GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0',
});

const stage = join(out, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
cpSync(join(out, 'forum'), join(stage, 'bin', 'forum'));
cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
run('tar', ['-czf', join(out, `forum-${sha}.tar.gz`), 'bin', 'dist'], undefined as never);
console.log('已打包: forum-' + sha + '.tar.gz');
