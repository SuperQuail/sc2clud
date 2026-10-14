const { readdirSync, statSync, readFileSync } = require('node:fs');
const { join, relative, sep } = require('node:path');

const DIST = process.argv[2] || 'D:/Code/Rust/SC2clud/web/dist';
const NEEDLES = ['devroom', '\u5f00\u53d1\u9875\u9762', '\u5f00\u53d1\u8005\u623f\u95f4'];

function walk(d) {
  const out = [];
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

const all = walk(DIST);
const product = all.filter((f) => relative(DIST, f).split(sep)[0] !== 'devroom');
const scannable = product.filter((f) => /\.(js|html|css|json|txt|map)$/i.test(f));
console.log('产物文件 ' + all.length + ' 个；产品侧 ' + product.length + ' 个，其中可扫 ' + scannable.length + ' 个（dist/devroom/** 是 DevRoom 自己的入口，按设计跳过）');

const SELF = 'D:/Code/Rust/SC2clud/web/src/ui/dev-entry.tsx';
const selfTxt = readFileSync(SELF, 'utf8');
const selfHits = NEEDLES.filter((n) => selfTxt.includes(n));
console.log('自检：src/ui/dev-entry.tsx 命中 ' + selfHits.length + '/' + NEEDLES.length + ' ' + JSON.stringify(selfHits));

let total = 0;
for (const f of scannable) {
  const txt = readFileSync(f, 'utf8');
  for (const needle of NEEDLES) {
    let i = 0;
    while ((i = txt.indexOf(needle, i)) >= 0) {
      total++;
      console.log('命中 ' + JSON.stringify(needle) + ' @ ' + relative(DIST, f).split(sep).join('/') + ':' + i);
      console.log('   …' + txt.slice(Math.max(0, i - 140), i + 180).replace(/\n/g, '\\n') + '…');
      i += needle.length;
    }
  }
}
console.log('产品产物里的 devroom 命中总数：' + total + '（期望 0）');
process.exit(total === 0 ? 0 : 1);
