// CDP 页面驱动器：启动 headless Chrome，逐页访问，收集 DOM/控制台/失败请求，出图。
// 用法：node page-driver.mjs <sessionCookie> <outDir> <plan.json>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cdp } from './miniws.mjs';

const CHROME = process.env.BT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.BT_CDP_PORT || 9223);
const [, , COOKIE, OUTDIR, PLANFILE] = process.argv;
const plan = JSON.parse(fs.readFileSync(PLANFILE, 'utf8'));
fs.mkdirSync(OUTDIR, { recursive: true });

// 每次跑都从干净 profile 开始：否则上一次的 localStorage/cookie 会让「游客视角」那几页不可重复
const udd = path.join(process.cwd(), '.tools', 'bt-chrome-' + PORT);
fs.rmSync(udd, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,900', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + udd, '--disable-features=Translate',
  'about:blank',
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome devtools not up');
}

const page = await targets();
const c = cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Network.enable');
await c.send('Log.enable');
if (COOKIE) {
  await c.send('Network.setCookie', {
    name: plan.cookieName || 'forum_dev_session', value: COOKIE,
    domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  });
}

const results = [];
const reqs = [];
c.on((m) => { if (m.method === 'Network.requestWillBeSent') reqs.push(1); });
for (const p of plan.pages) {
  const consoleMsgs = [], failed = [], pageErrors = [], requests = [];
  reqs.length = 0;
  const off = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleMsgs.push({ type: m.params.type, text: String(txt).slice(0, 300) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 400));
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') consoleMsgs.push({ type: 'log:' + e.source, text: String(e.text).slice(0, 300) });
    } else if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.includes('/art/') || u.includes('/favicon')) {
        requests.push({ url: u, type: m.params.type, doc: m.params.documentURL,
          stack: (m.params.initiator?.stack?.callFrames || []).slice(0, 6).map((f) => f.url + ':' + f.lineNumber) });
      }
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400 && p.recordHttp !== false) failed.push({ status: r.status, url: r.url.slice(0, 200), type: m.params.type });
    } else if (m.method === 'Network.loadingFailed') {
      failed.push({ status: 0, url: '', type: m.params.type, err: m.params.errorText });
    }
  };
  c.on(off);
  const t0 = Date.now();
  let navErr = null;
  // 每页换一个 X-Forwarded-For：dev 的限流桶按客户端 IP 计。不换的话第 10 页起全被 429 盖住
  // （前一位施工者在 127.0.0.1 上留了桶）。trusted_proxies=127.0.0.1，所以这个头被采信。
  if (p.xff) await c.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': p.xff } });
  try {
    await c.send('Page.navigate', { url: plan.base + p.url });
  } catch (e) { navErr = String(e.message); }
  // 等「内容稳定」而不是等网络静默：轮询 <main> 的文本长度，连续 2 次不变才算渲染完，
  // 上限 maxWaitMs。第一版用「网络静默」判据，结果首页在 React 还没挂载时就被判为完成 —— 截出一张白图。
  const hard = Date.now() + (p.maxWaitMs ?? 15000);
  let prevLen = -1, stable = 0, lastLen = 0;
  while (Date.now() < hard) {
    await new Promise((r) => setTimeout(r, 350));
    // 「稳定」不算完：骨架屏/加载文案还在屏幕上时不算渲染完（第一版把骨架屏当成了最终画面）
    const ev0 = await c.send('Runtime.evaluate', {
      expression: "JSON.stringify({l:(document.querySelector('main')||document.body).innerText.length," +
        "s:document.querySelectorAll('.animate-pulse,[data-skeleton],.skeleton').length," +
        "t:/正在加载|加载中|Loading/.test((document.querySelector('main')||document.body).innerText)})",
      returnByValue: true,
    }).catch(() => ({ result: { value: '{"l":0,"s":0,"t":false}' } }));
    let st0; try { st0 = JSON.parse(ev0.result.value); } catch { st0 = { l: 0, s: 0, t: false }; }
    lastLen = st0.l;
    if (st0.s > 0 || st0.t) { prevLen = -1; stable = 0; continue; }
    if (lastLen === prevLen) { stable++; if (stable >= 2 && Date.now() - t0 > 1200) break; }
    else { stable = 0; prevLen = lastLen; }
  }
  await new Promise((r) => setTimeout(r, p.waitMs ?? 300));
  const ev = await c.send('Runtime.evaluate', {
    expression: 'JSON.stringify(' + probeFn.toString() + '())',
    returnByValue: true, awaitPromise: false,
  }).catch((e) => ({ result: { value: JSON.stringify({ error: String(e.message) }) } }));
  let dom; try { dom = JSON.parse(ev.result.value); } catch (e) { dom = { error: 'probe failed: ' + ev.result?.value }; }
  const shot = path.join(OUTDIR, p.shot);
  let shotPx = null;
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(s.data, 'base64'));
    shotPx = '1440x900';
    await c.send('Emulation.clearDeviceMetricsOverride');
  } catch (e) { /* 截图失败如实记录 */ dom.shotError = String(e.message); }
  results.push({
    name: p.name, url: p.url, title: dom.title, ms: Date.now() - t0, navErr,
    text: dom.text, counts: dom.counts, hasErrorBoundary: dom.hasErrorBoundary,
    bodyLen: dom.bodyLen, spinnerOnly: dom.spinnerOnly,
    console: consoleMsgs, pageErrors, failed, requests,
    http: p.recordHttp === false ? [] : failed.filter((f) => f.status >= 400),
    shot: path.relative(process.cwd(), shot),
    shotBytes: fs.existsSync(shot) ? fs.statSync(shot).size : 0, shotPx,
    shotMtime: fs.existsSync(shot) ? fs.statSync(shot).mtime.toISOString() : null,
    expect: p.expect || null,
  });
  c.off(off);
  await new Promise((r) => setTimeout(r, 250));
}
c.close();
chrome.kill();
fs.writeFileSync(path.join(OUTDIR, 'pages.json'), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.map((r) => ({
  name: r.name, url: r.url, title: r.title, bodyLen: r.bodyLen, spinnerOnly: r.spinnerOnly,
  err: r.hasErrorBoundary, pageErrors: r.pageErrors.length, http4xx: r.http.length, shotBytes: r.shotBytes,
})), null, 1));

// 注入到页面里跑的探针：只读 DOM，不改页面。
function probeFn() {
  const main = document.querySelector('main') || document.body;
  const txt = (main.innerText || '').replace(/\s+/g, ' ').trim();
  const all = document.body.innerText || '';
  const counts = {
    cards: document.querySelectorAll('[data-testid], article, li').length,
    links: document.querySelectorAll('a').length,
    inputs: document.querySelectorAll('input, textarea, select').length,
    buttons: document.querySelectorAll('button, [role=button]').length,
    forms: document.querySelectorAll('form').length,
    tables: document.querySelectorAll('table').length,
    headings: document.querySelectorAll('h1,h2,h3').length,
    articles: document.querySelectorAll('article').length,
  };
  const errWords = ['出错了', 'Something went wrong', 'Unexpected Application Error', '出错', '意外错误', '渲染出错'];
  const spinWords = ['正在加载', '加载中…', '加载中...'];
  return {
    title: document.title,
    text: txt.slice(0, 1200),
    bodyLen: txt.length,
    counts,
    hasErrorBoundary: errWords.some((w) => all.includes(w)),
    spinnerOnly: txt.length < 30 && spinWords.some((w) => all.includes(w)),
  };
}
