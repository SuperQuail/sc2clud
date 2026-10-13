import sys, json, os, subprocess, time
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
ok, _ = bt_http.login()
# 1) 接口本身有没有数据
for p in ["/api/v1/users/Alenger", "/api/v1/users/Alenger/topics?limit=20"]:
    st, b = bt_http.jcall("GET", p)
    d = b.get("data")
    print(p, "->", st, "count", (len(d) if isinstance(d, list) else ("obj keys=" + ",".join(sorted(d.keys())) if isinstance(d, dict) else d)))
# 2) 页面到底是「一直转圈」还是「最终出现」
probe = r'''
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { cdp } from './miniws.mjs';
const PORT=9250;
const udd = path.join(process.cwd(),'.tools','bt-chrome-'+PORT);
fs.rmSync(udd,{recursive:true,force:true});
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--window-size=1440,900','--remote-debugging-port='+PORT,'--user-data-dir='+udd,'about:blank'],{stdio:'ignore'});
let page;
for(let i=0;i<80;i++){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();page=l.find(t=>t.type==='page');if(page)break;}catch{} await new Promise(r=>setTimeout(r,250));}
const c=cdp(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
const reqs=[];
c.on(m=>{ if(m.method==='Network.responseReceived' && m.params.response.url.includes('/api/')) reqs.push(m.params.response.status+' '+m.params.response.url.replace('http://127.0.0.1:19999','')); });
await c.send('Network.setCookie',{name:'forum_dev_session',value:process.argv[2],domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Lax'});
await c.send('Network.setExtraHTTPHeaders',{headers:{'X-Forwarded-For':'192.0.2.77'}});
await c.send('Page.navigate',{url:'http://127.0.0.1:19999/dev/u/Alenger?theme=light'});
const samples=[];
for (let i=0;i<10;i++){
  await new Promise(r=>setTimeout(r,2000));
  const ev = await c.send('Runtime.evaluate',{expression:"JSON.stringify({len:(document.querySelector('main')||document.body).innerText.length, spinning:/正在加载|加载中/.test((document.querySelector('main')||document.body).innerText), last:(document.querySelector('main')||document.body).innerText.slice(-160)})",returnByValue:true});
  samples.push({sec:(i+1)*2, ...JSON.parse(ev.result.value)});
}
const s = await c.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('shots/blindtest/14b-profile-self-after20s.png', Buffer.from(s.data,'base64'));
fs.writeFileSync('shots/blindtest/_profile-timeline.json', JSON.stringify({samples, api:reqs},null,1),'utf8');
c.close(); process.exit(0);
'''
open(r"D:\Code\Rust\SC2clud\scripts\blindtest\_profile.mjs","w",encoding="utf-8").write(probe)
cookie = [c for c in bt_http._jar if c.name=="forum_dev_session"][0].value
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\_profile.mjs", cookie], capture_output=True, cwd=r"D:\Code\Rust\SC2clud", timeout=200)
print("driver rc", r.returncode, r.stderr.decode("utf-8","replace")[:300])
print("written")
