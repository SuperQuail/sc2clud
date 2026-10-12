import { useEffect, useState } from 'react';
import V1 from './v1';
import V2 from './v2';

// 一次性量测页（不进产品构建）：把页面放进指定宽度的 iframe 里，报告比该宽度更宽的元素。
// 用 iframe 而不是 window-size：--headless=new 下 --window-size 管不住布局视口（实测 innerWidth 恒为 512）。
const WIDTHS = [375, 768, 1024, 1200, 1440];

async function measure(url: string, width: number): Promise<string[]> {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + width + 'px;height:1200px;border:0';
  f.src = url;
  document.body.appendChild(f);
  await new Promise<void>((res) => { f.onload = () => res(); });
  await new Promise((r) => setTimeout(r, 300));
  const d = f.contentDocument;
  const out: string[] = [];
  if (d !== null) {
    out.push('@' + width + ' docScrollW=' + d.documentElement.scrollWidth + ' bodyScrollW=' + d.body.scrollWidth);
    let n = 0;
    d.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > width + 0.5 && r.width > 20 && n < 12) {
        n++;
        out.push('   ' + Math.round(r.left) + '..' + Math.round(r.right) + ' w=' + Math.round(r.width) + ' <' + el.tagName.toLowerCase() + '> ' + String(el.className).slice(0, 60));
      }
    });
  }
  f.remove();
  return out;
}


// 硬指标：1440×900 下完整可见的卡片数（卡片视图）/ 完整可见的行数（紧凑视图）
async function measureCount(url: string): Promise<string[]> {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:absolute;left:-99999px;top:0;width:1440px;height:900px;border:0';
  f.src = url + '&view=card';
  document.body.appendChild(f);
  await new Promise<void>((res) => { f.onload = () => res(); });
  await new Promise((r) => setTimeout(r, 300));
  const d = f.contentDocument;
  const out: string[] = [];
  if (d !== null) {
    const cards = [...d.querySelectorAll('main li')].filter((el) => el.querySelector('img,div[aria-hidden]') !== null);
    const full = cards.filter((el) => { const r = el.getBoundingClientRect(); return r.height > 80 && r.top >= 0 && r.bottom <= 900; });
    const cols = new Set(cards.slice(0, 6).map((el) => Math.round(el.getBoundingClientRect().left))).size;
    out.push('  卡片视图 1440×900：卡片 ' + cards.length + ' 张，完整可见 ' + full.length + ' 张，列数 ' + cols +
      '，首卡高 ' + Math.round((cards[0]?.getBoundingClientRect().height ?? 0)) + 'px，栅格首行 top ' + Math.round((cards[0]?.getBoundingClientRect().top ?? 0)) + 'px');
  }
  f.remove();
  return out;
}

export default function Probe() {
  const [lines, setLines] = useState<string[]>(['running…']);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const v = p.get('v') ?? '1';
    const inner = (window.self !== window.top);
    if (inner) return; // 被嵌进来量的那一份不再渲染页面，避免递归
    const url = '/preview-c.html?v=' + v + '&theme=light';
    void (async () => {
      const acc: string[] = [];
      for (const w of WIDTHS) {
        for (const view of ['card', 'compact']) {
          acc.push(...(await measure(url + '&view=' + view, w)));
        }
      }
      for (const v of ['1', '2']) acc.push('v' + v + '：', ...(await measureCount('/preview-c.html?v=' + v + '&theme=light')));
      setLines(acc);
    })();
  }, []);
  const p = new URLSearchParams(location.search);
  if (window.self !== window.top) return <>{p.get('v') === '2' ? <V2 /> : <V1 />}</>;
  return <pre id="probe-out">{lines.join('\n')}</pre>;
}