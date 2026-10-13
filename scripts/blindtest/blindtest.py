#!/usr/bin/env python3
"""盲测主脚本（一键可重复）。

  python scripts/blindtest/blindtest.py

做三件事，然后把结果写成 JSON 交给报告：
  1) 页面扫描（CDP + headless Chrome）：每页截图 1440x900、抓控制台报错、失败请求、DOM 关键元素；
  2) 接口矩阵：真实内容断言 + 「不存在的接口必须 404 JSON」；
  3) 汇总判定：功能没做 / 行为不对 / 做了但界面找不到入口。

不写库：唯一的写操作是登录 probe-admin。
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SHOTS = os.path.join(ROOT, "shots", "blindtest")
sys.path.insert(0, HERE)
import bt_http

def run(cmd, timeout=1800, env=None):
    e = dict(os.environ)
    if env: e.update(env)
    p = subprocess.run(cmd, capture_output=True, cwd=ROOT, env=e, timeout=timeout)
    return p.returncode, (p.stdout or b"").decode("utf-8", "replace"), (p.stderr or b"").decode("utf-8", "replace")

def judge_only():
    """只重跑判定，复用上一次扫描的原始数据（调判据时用，省一次 6 分钟扫描）。"""
    pages = json.load(open(os.path.join(SHOTS, "full", "pages.json"), encoding="utf-8"))
    api = json.load(open(os.path.join(SHOTS, "_api.json"), encoding="utf-8"))
    verdicts = judge(pages, api)
    json.dump({"pages": pages, "api": api, "verdicts": verdicts,
               "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
              open(os.path.join(SHOTS, "_result.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("pages %d / api %d" % (len(pages), len(api)))
    for v in verdicts:
        print("%-4s %-26s %s" % (v["verdict"], v["name"], v["why"][:150]))

def main():
    if "--judge-only" in sys.argv:
        judge_only(); return
    t0 = time.time()
    os.makedirs(SHOTS, exist_ok=True)
    ok, info = bt_http.login()
    if not ok:
        print("FATAL: 登录失败", json.dumps(info, ensure_ascii=False)[:400]); sys.exit(2)
    cookie = [c for c in bt_http._jar if c.name == "forum_dev_session"][0].value

    print("[1/3] 页面扫描 …")
    rc, so, se = run(["node", os.path.join(HERE, "page-driver.mjs"), cookie,
                      os.path.join(SHOTS, "full"), os.path.join(HERE, "plan-full.json")],
                     env={"BT_CDP_PORT": "9240"})
    if rc != 0:
        print("  driver rc=", rc, se[:600])

    print("[2/3] 接口矩阵 …")
    rc2, so2, se2 = run([sys.executable, os.path.join(HERE, "run-api.py")])
    print("  ", so2.strip()[:200], se2.strip()[:300])

    print("[3/3] 判定 …")
    pages = json.load(open(os.path.join(SHOTS, "full", "pages.json"), encoding="utf-8"))
    api = json.load(open(os.path.join(SHOTS, "_api.json"), encoding="utf-8"))
    verdicts = judge(pages, api)
    json.dump({"pages": pages, "api": api, "verdicts": verdicts,
               "ran_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "seconds": round(time.time() - t0, 1)},
              open(os.path.join(SHOTS, "_result.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    npass = sum(1 for v in verdicts if v["verdict"] == "PASS")
    print("\n页面 %d 项：PASS %d / FAIL %d；接口 %d 项：PASS %d / FAIL %d" % (
        len([v for v in verdicts if v["kind"] == "page"]), npass,
        len([v for v in verdicts if v["kind"] == "page" and v["verdict"] != "PASS"]),
        len(api), sum(1 for r in api if r["ok"]), sum(1 for r in api if not r["ok"])))
    for v in verdicts:
        if v["verdict"] != "PASS":
            print("  %-4s %-26s %s" % (v["verdict"], v["name"], v["why"]))
    print("结果 JSON：shots/blindtest/_result.json（用时 %.0fs）" % (time.time() - t0))

def judge(pages, api):
    """每页一条判定。判据全部来自页面实际 DOM，不看 HTTP 200。"""
    V = []
    def add(name, url, verdict, why, evidence, shot=None, cls=None):
        V.append({"kind": "page", "name": name, "url": url, "verdict": verdict, "why": why,
                  "evidence": evidence, "shot": shot, "class": cls})

    for p in pages:
        name, url = p["name"], p["url"]
        text = p["text"] or ""
        ev = {"bodyLen": p["bodyLen"], "counts": p["counts"], "pageErrors": p["pageErrors"],
              "http4xx": ["%s %s" % (f["status"], f["url"]) for f in p["http"]],
              "console": [c["text"] for c in p["console"]], "shotBytes": p["shotBytes"],
              "shot": p["shot"], "shotPx": p.get("shotPx")}
        # 通用失败形态
        if p["pageErrors"]:
            add(name, url, "FAIL", "页面运行时抛异常（错误边界/白屏风险）", ev, p["shot"]); continue
        if p["hasErrorBoundary"]:
            add(name, url, "FAIL", "渲染出错误边界文案", ev, p["shot"]); continue
        if p["bodyLen"] < 5 or p["spinnerOnly"]:
            add(name, url, "FAIL", "主区域没有内容（空白/只有加载态）", ev, p["shot"]); continue
        if p["shotBytes"] < 6000:
            add(name, url, "FAIL", "截图几乎全白（%d 字节）" % p["shotBytes"], ev, p["shot"]); continue
        # 每页应有元素
        c = p["counts"]
        need = []
        if name.startswith("首页"):
            need = [("分区列表", "分区" in text), ("帖子卡片", c["articles"] > 0 or c["cards"] > 0),
                    ("排序控件", "最新回复" in text or "排序" in text)]
        elif name.startswith("分区页-") and "不存在" not in name:
            need = [("分区名", c["headings"] > 0), ("帖子卡片", "帖子" in text or c["cards"] > 0),
                    ("类型筛选", "全部" in text)]
        elif name.startswith("分区页-不存在"):
            need = [("错误说明", "不存在" in text or "删除" in text), ("重试入口", "重试" in text)]
        elif name.startswith("帖子页-") and "不存在" not in name:
            need = [("标题", c["headings"] > 0), ("正文", len(text) > 120),
                    ("评论区", ("回复" in text) or ("评论" in text) or c["articles"] >= 2)]
        elif name.startswith("帖子页-不存在"):
            need = [("错误说明", "不存在" in text or "删除" in text), ("重试入口", "重试" in text)]
        elif name.startswith("个人主页") and "不存在" not in name:
            need = [("昵称", "Alenger" in text or "probe-admin" in text or c["headings"] > 0),
                    ("作品/帖子区", "帖子" in text or c["articles"] > 0 or c["cards"] > 0)]
        elif name.startswith("个人主页-不存在"):
            need = [("错误说明", "不存在" in text or "删除" in text)]
        elif name.startswith("发帖页"):
            need = [("标题输入", c["inputs"] >= 2), ("正文编辑器", "正文" in text), ("发布按钮", "发布" in text)]
        elif name.startswith("登录页"):
            need = [("账号输入", "用户名" in text), ("密码输入", "密码" in text), ("验证码位", "验证码" in text or "图形" in text)]
        elif name.startswith("注册页"):
            need = [("表单", c["inputs"] >= 3), ("验证码位", "验证码" in text or "图形" in text)]
        elif name.startswith("激活页"):
            need = [("验证码输入", c["inputs"] >= 1), ("提交", "激活" in text)]
        elif name.startswith("申诉页"):
            need = [("表单", c["inputs"] >= 3), ("事由选择", "申诉" in text)]
        elif name.startswith("搜索页") or name.startswith("下载页") or name.startswith("私信页") or name.startswith("通知页"):
            need = [("有内容", len(text) > 20)]
        elif name == "404页":
            need = [("404 文案", "404" in text), ("回首页入口", "回首页" in text or "首页" in text)]
        elif name.startswith("设置页"):
            need = [("资料表单", c["inputs"] >= 2), ("退出登录", "退出" in text)]
        elif name.startswith("后台-"):
            need = [("后台标题", "管理后台" in text or "权限" in text), ("侧栏导航", c["buttons"] >= 5)]
        elif name.startswith("设计房间"):
            need = [("设计房间标题", "DevRoom" in text or "控件" in text)]
        missing = [n for n, okk in need if not okk]
        if missing:
            add(name, url, "FAIL", "缺少应有元素: " + "、".join(missing), ev, p["shot"]); continue
        # 站内接口 4xx（排除负例页面）
        bad_http = [f for f in p["http"] if not any(k in p["url"] for k in ("no-such", "00000000"))]
        bad_http = [f for f in bad_http if "/art/" not in f["url"] and "favicon" not in f["url"]]
        warn = ""
        if bad_http:
            warn = "；有接口 4xx: " + ", ".join("%s %s" % (f["status"], f["url"]) for f in bad_http[:3])
        errs = [c.get("text", "") for c in p["console"] if "Failed to load resource" not in c.get("text", "")]
        if errs:
            warn += "；控制台: " + "; ".join(errs[:2])
        add(name, url, "PASS" if not warn else "WARN", ("渲染出应有元素" + warn), ev, p["shot"])
    return V

main()
