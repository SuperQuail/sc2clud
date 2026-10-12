// CDP 断言：超长评论是否真的被折叠（有「展开」按钮，且内容高度被限制到阈值内）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const URL_ARG = process.argv[2]!;
const THRESHOLD = Number(process.argv[3] ?? 180);
const PORT = 9338;
const BROWSERS = [process.env.SHOT_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean) as string[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = spawn(BROWSERS.find((p) => existsSync(p))!, ['--headless=new', '--disable-gpu', '--window-size=1440,2600', '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); } }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ARG), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await sleep(1800);
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '展开');
      const masked = [...document.querySelectorAll('div')].filter((d) => d.style.maskImage && d.style.maxHeight).map((d) => d.getBoundingClientRect().height);
      return { hasButton: !!btn, maskedHeights: masked };
    })()`,
  });
  const v = r.result.result.value as { hasButton: boolean; maskedHeights: number[] };
  console.log('折叠中的内容块：' + JSON.stringify(v.maskedHeights) + '  有「展开」按钮：' + v.hasButton);
  const limited = v.maskedHeights.length > 0 && v.maskedHeights.every((h) => h <= THRESHOLD + 2);
  console.log((limited ? '✓' : '✗') + ' 内容高度被限制在 ' + THRESHOLD + 'px 内');
  console.log((v.hasButton ? '✓' : '✗') + ' 出现了「展开」按钮');
  ws.close();
} finally { browser.kill(); }
