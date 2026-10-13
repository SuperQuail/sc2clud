import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9253;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.150'}});
const log=[];
c.on(m=>{ if(m.method==='Network.responseReceived' && m.params.response.url.includes('/api/')) log.push(m.params.response.status+' '+m.params.response.url.replace('http://127.0.0.1:19999','')); });
const EV = (expr) => c.send('Runtime.evaluate',{expression:expr,returnByValue:true}).then(r=>r.result.value);
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/login?theme=light'});
await new Promise(r=>setTimeout(r,7000));
const step1 = JSON.parse(await EV("JSON.stringify({inputs:[...document.querySelectorAll('input')].map(i=>({name:i.name,type:i.type})),hasCaptcha:/图形验证码/.test(document.body.innerText)})"));
const submitExpr = [
  '(()=>{',
  '  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;',
  '  const ins=[...document.querySelectorAll("input")];',
  '  const u=ins.find(i=>i.type==="text"), p=ins.find(i=>i.type==="password");',
  '  if(!u||!p) return "missing";',
  '  set.call(u, ' + JSON.stringify(process.env.BT_USER||'probe-admin') + '); u.dispatchEvent(new Event("input",{bubbles:true}));',
  '  set.call(p, ' + JSON.stringify('Probe-Dev-2026!') + '); p.dispatchEvent(new Event("input",{bubbles:true}));',
  '  const f=document.querySelector("form"); f.requestSubmit(); return "submitted";',
  '})()'
].join('\n');
const submitted = await EV(submitExpr);
await new Promise(r=>setTimeout(r,6000));
const st2 = JSON.parse(await EV("JSON.stringify({captchaShown:/图形验证码/.test(document.body.innerText),text:document.body.innerText.slice(0,500)})"));
const shot1 = await c.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('shots/blindtest/17b-login-captcha-challenge.png', Buffer.from(shot1.data,'base64'));
fs.writeFileSync('shots/blindtest/_loginflow.json', JSON.stringify({step1, submitted, st2, log},null,1),'utf8');
c.close(); process.exit(0);