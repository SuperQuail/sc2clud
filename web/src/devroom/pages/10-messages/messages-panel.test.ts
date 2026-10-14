import { expect, it } from 'vitest';
import { plainText } from './messages-panel';

// L8（拍板 §L8）：「允许用户复制 unicode 表情进去」——**不做表情按钮**，
// 靠用户自己粘贴，所以要做的是**保证正文链路不破坏它**。
// 私信体在契约里是纯文本 varchar（message/service.go 的 maxBodyRunes=2000 + TrimSpace），
// 前端唯一的改写点就是这里：编辑器给的 HTML → 入库的纯文本（routes/messages.tsx 也走它）。
//
// 为什么单独立一条：表情不是「一个字符」——ZWJ 家庭、肤色修饰符、旗帜、键帽都是**多个码点**，
// 任何按码点/代理对切的实现都会把它们剪成看不懂的东西，而那种坏法在截图上看不出来。
it('多码点表情原样穿过正文链路（ZWJ 家庭 / 肤色 / 旗帜 / 键帽）', () => {
  const cases = [
    '👨‍👩‍👧',      // ZWJ 三连：4 个码点 + 2 个 ZWJ
    '👍🏽',          // 肤色修饰符：基础字符 + 修饰符
    '🇨🇳',          // 区域指示符成对
    '1️⃣',           // 键帽：数字 + VS16 + 组合包围键
    '🫡',           // 单码点（代理对）也要在
  ];
  for (const emoji of cases) {
    expect(plainText('<p>' + emoji + '</p>'), emoji).toBe(emoji);
  }
});

it('表情与文字混排时只有 HTML 被剥掉，表情与顺序都不动', () => {
  // 编辑器把每一行包成 <p>，段落之间是换行（后端 body 是单行纯文本，调用方再把换行折成空格）
  const html = '<p>谢谢 🎉 辛苦了</p><p>稍后 👨‍👩‍👧 也来</p>';
  expect(plainText(html)).toBe('谢谢 🎉 辛苦了\n稍后 👨‍👩‍👧 也来');
  // 行内标记（加粗/链接）只脱标签、不吃内容
  expect(plainText('<p><strong>@陆战队员</strong> 看这个 <a href="/t/tp-1">🫡</a></p>')).toBe('@陆战队员 看这个 🫡');
});

it('HTML 实体解码不会把表情搅坏（顺序：先剥标签、再解实体）', () => {
  // &amp; 与表情同时出现：解码必须在剥标签之后，否则「&lt;」会被当成标签头
  expect(plainText('<p>a &amp; b 🎉</p>')).toBe('a & b 🎉');
  expect(plainText('<p>&lt;b&gt; 不是标签 🫡</p>')).toBe('<b> 不是标签 🫡');
});
