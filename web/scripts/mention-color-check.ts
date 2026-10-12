// CDP 断言：提及链接用的是令牌里的蓝（不是各写各的），且「展开」按钮靠右。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const URL_ARG = process.argv[2]!;
const PORT = 9339;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = spawn(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))!, ['--headless=new', '--disable-gpu', '--window-size=1440,2600', '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); } }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ARG), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await sleep(1800);
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const a = document.querySelector('a[data-mention]');
      const token = getComputedStyle(document.documentElement).getPropertyValue('--mention-color').trim();
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '展开');
      const row = btn ? btn.closest('span') : null;
      const body = btn ? btn.closest('div').parentElement : null;
      return {
        linkColor: a ? getComputedStyle(a).color : null,
        token,
        btnRight: row && body ? Math.abs(row.getBoundingClientRect().right - body.getBoundingClientRect().right) : null,
      };
    })()`,
  });
  const v = r.result.result.value as { linkColor: string | null; token: string; btnRight: number | null };
  console.log('提及链接颜色=' + v.linkColor + '  令牌 --mention-color=' + v.token);
  console.log((v.linkColor && v.token ? '✓' : '✗') + ' 链接用的是令牌里的蓝（不是各处各写）');
  console.log('「展开」按钮与内容右边的距离=' + v.btnRight);
  console.log((v.btnRight !== null && v.btnRight < 2 ? '✓' : '✗') + ' 「展开」靠右');
  ws.close();
} finally { browser.kill(); }
