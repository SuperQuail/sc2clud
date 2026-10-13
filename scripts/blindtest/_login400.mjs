
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9254;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.151'}});
const hits=[];
c.on(m=>{ if(m.method==='Network.responseReceived' && m.params.response.url.includes('auth/login')) hits.push(m.params.requestId); });
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/login?theme=light'});
await new Promise(r=>setTimeout(r,7000));
const expr = ['(()=>{','const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;','const ins=[...document.querySelectorAll("input")];','const u=ins.find(i=>i.type==="text"), p=ins.find(i=>i.type==="password");','set.call(u,"probe-admin"); u.dispatchEvent(new Event("input",{bubbles:true}));','set.call(p,"Probe-Dev-2026!"); p.dispatchEvent(new Event("input",{bubbles:true}));','document.querySelector("form").requestSubmit(); return "ok";','})()'].join('\n');
await c.send('Runtime.evaluate',{expression:expr,returnByValue:true});
await new Promise(r=>setTimeout(r,4000));
const bodies=[];
for (const id of hits){ try { const b = await c.send('Network.getResponseBody',{requestId:id}); bodies.push(b.body.slice(0,400)); } catch(e){ bodies.push('ERR '+e.message); } }
fs.writeFileSync('shots/blindtest/_login400.json', JSON.stringify({bodies},null,1),'utf8');
c.close(); process.exit(0);
