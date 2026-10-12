// 工具栏验收：**真的一个一个点**，断言编辑器内容里出现对应的 HTML 标签。
// 点了没反应的按钮，就该从工具栏里删掉——留着比没有更糟。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const URL_ARG = process.argv[2]!;
const PORT = 9341;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = spawn(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))!, ['--headless=new', '--disable-gpu', '--window-size=1440,900', '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); } }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ARG), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1800);

  const html = async () => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: "document.querySelector('[contenteditable=true]').innerHTML" });
    return r.result.result.value as string;
  };
  const clickButton = async (label: string) => {
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    });
    const p = r.result.result.value;
    if (!p) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return true;
  };
  const clear = async () => {
    await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(200);
  };
  const typeText = async () => {
    await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
    await send('Input.insertText', { text: '测试文字' });
    await sleep(150);
  };
  const selectAll = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(150);
  };

  const cases: Array<[string, string, boolean]> = [
    ['粗体', '<strong', true],
    ['斜体', '<em', true],
    ['行内代码', '<code', true],
    ['引用', '<blockquote', false],
    ['无序列表', '<ul', false],
    ['链接', 'href=', true],
  ];
  let bad = 0;
  for (const [label, needle, needSelection] of cases) {
    await clear();
    await typeText();
    if (needSelection) await selectAll();
    const ok = await clickButton(label);
    await sleep(350);
    const h = await html();
    const hit = h.includes(needle);
    if (!hit) bad++;
    console.log((hit ? '✓' : '✗') + ' ' + label + ' → ' + (ok ? '' : '【按钮不存在】') + (hit ? needle + ' 出现了' : '没有 ' + needle + '　实际：' + h.slice(0, 200)));
  }
  console.log(bad === 0 ? '全部按钮有效' : bad + ' 个按钮无效——应从工具栏删掉');
  ws.close();
} finally { browser.kill(); }
