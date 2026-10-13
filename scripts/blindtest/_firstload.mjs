import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cdp } from './miniws.mjs';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=Number(process.env.BT_CDP_PORT||9232);
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
const log=[];
c.on(m=>{
  if(m.method==='Network.requestWillBeSent') log.push({t:Date.now(),e:'req',u:m.params.request.url.replace('http://127.0.0.1:19999','')});
  if(m.method==='Network.responseReceived') log.push({t:Date.now(),e:'res',s:m.params.response.status,u:m.params.response.url.replace('http://127.0.0.1:19999','')});
  if(m.method==='Network.loadingFailed') log.push({t:Date.now(),e:'FAIL',err:m.params.errorText,ty:m.params.type});
  if(m.method==='Runtime.exceptionThrown') log.push({t:Date.now(),e:'EXC',d:String(m.params.exceptionDetails?.exception?.description||'').slice(0,400)});
  if(m.method==='Runtime.consoleAPICalled') log.push({t:Date.now(),e:'c',ty:m.params.type,a:(m.params.args||[]).map(a=>String(a.value??a.description).slice(0,200))});
  if(m.method==='Log.entryAdded') log.push({t:Date.now(),e:'log',lvl:m.params.entry.level,x:String(m.params.entry.text).slice(0,200)});
});
// 模拟真实用户：干净 profile + 无 cookie
const t0=Date.now();
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/?theme=light'});
const samples=[];
for (let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,1000));
  const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({len:(document.querySelector('main')||document.body).innerText.length,root:document.getElementById('root')?.children.length??-1,ready:document.readyState})",returnByValue:true});
  samples.push({sec:i+1, ...JSON.parse(ev.result.value)});
}
fs.writeFileSync('shots/blindtest/_guest-firstload.json', JSON.stringify({samples, log: log.map(x=>({...x, dt:x.t-t0}))},null,1),'utf8');
const s = await c.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('shots/blindtest/_guest-firstload.png', Buffer.from(s.data,'base64'));
c.close(); process.exit(0);
