import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cdp } from './miniws.mjs';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=9233;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
const events=[];
c.on(m=>{ if(m.method==='Network.requestWillBeSent') events.push({e:'req',u:m.params.request.url.replace('http://127.0.0.1:19999',''),t:m.params.type}); });
const out=[];
for (const u of ['/dev/admin','/dev/admin/','/dev/admin/nosuchscreen']) {
  events.length=0;
  await c.send('Page.navigate',{url:'http://127.0.0.1:19999'+u});
  await new Promise(r=>setTimeout(r,6000));
  const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({href:location.href,path:location.pathname,main:(document.querySelector('main')||document.body).innerText.slice(0,80)})",returnByValue:true});
  out.push({url:u, after: JSON.parse(ev.result.value), nav:[...new Set(events.filter(x=>x.t==='Document').map(x=>x.u))]});
  events.length=0;
  // 等 SPA 稳定，再看一次（重定向的落点）
  await new Promise(r=>setTimeout(r,3000));
  const ev2 = await c.send('Runtime.evaluate',{expression:"JSON.stringify({href:location.href,path:location.pathname,main:(document.querySelector('main')||document.body).innerText.slice(0,80)})",returnByValue:true});
  out[out.length-1].settled = JSON.parse(ev2.result.value);
  out[out.length-1].spaNav = [...new Set(events.filter(x=>x.t==='Document').map(x=>x.u))];
}
fs.writeFileSync('shots/blindtest/_adminroute.json', JSON.stringify(out,null,1),'utf8');
c.close(); process.exit(0);
