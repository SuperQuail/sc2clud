import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9252;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
await c.send('Network.setCookie',{name:'forum_dev_session',value:process.argv[2],domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Lax'});
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.99'}});
const out={};
// A) 真实点击顶栏「管理后台」
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/?theme=light'});
await new Promise(r=>setTimeout(r,7000));
const click = await c.send('Runtime.evaluate',{expression:"(()=>{const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim()==='管理后台'); if(!a) return 'no-button'; a.click(); return a.getAttribute('href');})()",returnByValue:true});
out.clicked = click.result.value;
await new Promise(r=>setTimeout(r,6000));
const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({href:location.href,main:(document.querySelector('main')||document.body).innerText.slice(0,60)})",returnByValue:true});
out.afterClick = JSON.parse(ev.result.value);
// B) 直接敲 /dev/admin（等价于从收藏夹进来）
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/admin'});
await new Promise(r=>setTimeout(r,9000));
const ev2 = await c.send('Runtime.evaluate',{expression:"JSON.stringify({href:location.href,main:(document.querySelector('main')||document.body).innerText.slice(0,60)})",returnByValue:true});
out.directAdmin = JSON.parse(ev2.result.value);
fs.writeFileSync('shots/blindtest/_adminbug.json', JSON.stringify(out,null,1),'utf8');
c.close(); process.exit(0);
