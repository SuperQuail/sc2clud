import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'D:/Code/Rust/SC2clud/web/.tmp-style-b/shots';
mkdirSync(OUT, { recursive: true });
const shots = process.argv.slice(2);
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9444','--user-data-dir=D:/Code/Rust/SC2clud/web/.tmp-style-b/chrome-profile','about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch('http://127.0.0.1:9444/json/version'); return (await r.json()).webSocketDebuggerUrl; } catch { await sleep(300); }
  }
  throw new Error('chrome 未启动');
}
const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); let session = null;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.text);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('LOG', m.params.entry.text.slice(0, 160));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, useSession = true) {
  const mid = ++id; const msg = { id: mid, method, params };
  if (useSession && session) msg.sessionId = session;
  ws.send(JSON.stringify(msg));
  return new Promise((res) => pending.set(mid, res));
}
const t = await send('Target.createTarget', { url: 'about:blank' }, false);
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true }, false);
session = a.result.sessionId;
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
for (const spec of shots) {
  const [name, w] = spec.split(':');
  await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5199/' + name + '.html?' + name });
  await sleep(4500);
  const probe = await send('Runtime.evaluate', { expression: "JSON.stringify({h: document.documentElement.scrollHeight, root: document.getElementById('root')?.childElementCount ?? -1, avatars: document.querySelectorAll('[data-test=avatar]').length, btns: document.querySelectorAll('button').length})", returnByValue: true });
  console.log(name, probe.result?.result?.value, probe.result?.exceptionDetails?.text ?? '');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT + '/' + name + '.png', Buffer.from(shot.result.data, 'base64'));
}
ws.close(); chrome.kill();
console.log('done');
