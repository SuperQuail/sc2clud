import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9255;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.152'}});
const calls=[];
c.on(m=>{ if(m.method==='Network.responseReceived' && m.params.response.url.includes('auth/login')) calls.push(m.params.requestId); });
const EV = (e) => c.send('Runtime.evaluate',{expression:e,returnByValue:true}).then(r=>r.result.value);
const log=[];
async function shot(name){ const s=await c.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync('shots/blindtest/'+name, Buffer.from(s.data,'base64')); }
const FILL = [
'(()=>{',
'const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;',
'const ins=[...document.querySelectorAll("input")];',
'const U=ins.find(i=>i.name==="username"), P=ins.find(i=>i.name==="password");',
'const C=ins.find(i=>((i.getAttribute("aria-label")||"")+(i.placeholder||"")).indexOf("验证码")>=0);',
'set.call(U, window.__bt.u); U.dispatchEvent(new Event("input",{bubbles:true}));',
'set.call(P, window.__bt.p); P.dispatchEvent(new Event("input",{bubbles:true}));',
'if(C && window.__bt.c){ set.call(C, window.__bt.c); C.dispatchEvent(new Event("input",{bubbles:true})); }',
'document.querySelector("form").requestSubmit();',
'return JSON.stringify({u:U.value,plen:P.value.length,c:C?C.value:null});',
'})()'
].join('\n');
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/login?theme=light'});
await new Promise(r=>setTimeout(r,7000));
await EV('window.__bt={u:'+JSON.stringify('probe-admin')+',p:'+JSON.stringify('Probe-Dev-2026!')+',c:""}; 1');
log.push({step:'fill-no-captcha', r: await EV(FILL)});
await new Promise(r=>setTimeout(r,5000));
log.push({step:'after1', v: await EV('JSON.stringify({captchaShown:/图形验证码/.test(document.body.innerText),text:document.body.innerText.slice(0,260)})')});
await shot('17c-login-challenge.png');
fs.writeFileSync('shots/blindtest/_loginflow2.json', JSON.stringify({log, calls},null,1),'utf8');
c.close(); process.exit(0);