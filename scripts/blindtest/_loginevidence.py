import sys, json, os, subprocess
sys.path.insert(0, r"D:\Code\Rust\SC2clud\scripts\blindtest")
import bt_http
out={}
# 1) 真实浏览器表单提交的 400 响应体（同一条链路）
mjs = r'''
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
'''
open(r"D:\Code\Rust\SC2clud\scripts\blindtest\_login400.mjs","w",encoding="utf-8").write(mjs)
r = subprocess.run(["node", r"D:\Code\Rust\SC2clud\scripts\blindtest\_login400.mjs"], capture_output=True, cwd=r"D:\Code\Rust\SC2clud", timeout=200)
out["browser_form_post"] = json.load(open(r"D:\Code\Rust\SC2clud\shots\blindtest\_login400.json", encoding="utf-8"))
# 2) 同一个端点：带 captcha_id + 正确答案（redis 里取）
st, b = bt_http.jcall("GET", "/api/v1/captcha")
cid = b["data"]["id"]
ans = bt_http.redis_get("captcha:" + cid)
st2, hd, tx = bt_http.call("POST", "/api/v1/auth/login", {"login":"probe-admin","password":"Probe-Dev-2026!","captcha_id":cid,"captcha_answer":ans})
out["with_captcha"] = {"status": st2, "body": tx[:300], "sent_answer": ans}
# 3) 故意不带 captcha
st3, hd3, tx3 = bt_http.call("POST", "/api/v1/auth/login", {"login":"probe-admin","password":"Probe-Dev-2026!"})
out["without_captcha"] = {"status": st3, "body": tx3[:300], "ct": hd3.get("Content-Type")}
json.dump(out, open(r"D:\Code\Rust\SC2clud\shots\blindtest\_login-evidence.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print("ok")
