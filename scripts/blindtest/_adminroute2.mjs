import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9251;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
await c.send('Network.setCookie',{name:'forum_dev_session',value:process.argv[2],domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Lax'});
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.88'}});
const out=[];
for (const u of ['/dev/admin','/dev/admin/','/dev/admin/users']) {
  await c.send('Page.navigate',{url:'http://127.0.0.1:19999'+u});
  const samples=[];
  for (let i=0;i<6;i++){
    await new Promise(r=>setTimeout(r,1500));
    const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({href:location.pathname,len:(document.querySelector('main')||document.body).innerText.length,head:(document.querySelector('main')||document.body).innerText.slice(0,60).replace(/\\n/g,' / ')})",returnByValue:true});
    samples.push({t:(i+1)*1.5, ...JSON.parse(ev.result.value)});
  }
  out.push({navigate:u, samples});
}
fs.writeFileSync('shots/blindtest/_adminroute-auth.json', JSON.stringify(out,null,1),'utf8');
c.close(); process.exit(0);
