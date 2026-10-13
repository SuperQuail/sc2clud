import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cdp } from './miniws.mjs';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=9229;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<60;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
const log=[];
c.on(m=>{
  if(m.method==='Network.requestWillBeSent') log.push({e:'req',u:m.params.request.url});
  if(m.method==='Network.responseReceived') log.push({e:'res',s:m.params.response.status,u:m.params.response.url});
  if(m.method==='Network.loadingFailed') log.push({e:'fail',err:m.params.errorText,t:m.params.type});
  if(m.method==='Runtime.consoleAPICalled') log.push({e:'console',t:m.params.type,a:(m.params.args||[]).map(a=>a.value??a.description)});
  if(m.method==='Runtime.exceptionThrown') log.push({e:'exception',d:String(m.params.exceptionDetails?.exception?.description||'').slice(0,300)});
  if(m.method==='Log.entryAdded') log.push({e:'log',lvl:m.params.entry.level,txt:String(m.params.entry.text).slice(0,200)});
});
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/?theme=light'});
for (const t of [2000,4000,7000,11000]) {
  await new Promise(r=>setTimeout(r, t===2000?2000:3000));
  const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({ready:document.readyState, mainLen:(document.querySelector('main')?.innerText||'').length, bodyLen:document.body.innerText.length, mainChild:document.querySelector('main')?.innerHTML.slice(0,300), body:document.body.innerHTML.length, scripts:[...document.scripts].map(s=>s.src).slice(0,3)})",returnByValue:true});
  log.push({e:'probe@'+t, v: JSON.parse(ev.result.value)});
}
fs.writeFileSync('shots/blindtest/_trace-home.json', JSON.stringify(log,null,1),'utf8');
const s = await c.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('shots/blindtest/_trace-home.png', Buffer.from(s.data,'base64'));
c.close(); process.exit(0);
