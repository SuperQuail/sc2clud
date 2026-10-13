import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import HomePage from '../14-home';
import TopicPage from '../12-topic';

// 「发帖」入口的接线（2026-10-13 补）：这一页只有从别处进得来才有用。
// 断言**渲染出来的链接**，不是源码里那行字符串 —— 「共用同一个件」不等于「那一页真的渲染了它」
// （本项目已经栽过一次：以为 12-topic / 13-issue 会一并受益，实测那两页根本没渲染）。
// 同时把 href 打出来，给「点前 → 点后」留一份可复现的 URL 证据。
function composeAnchors(): HTMLAnchorElement[] {
  return [...document.querySelectorAll('a')].filter((a) =>
    (a.getAttribute('href') ?? '').includes('page=18-compose'),
  ) as HTMLAnchorElement[];
}

it('14-home 与 12-topic 的「发帖」按钮都指向 18-compose（渲染出来的链接，不是源码）', () => {
  for (const [name, Page] of [
    ['14-home', HomePage],
    ['12-topic', TopicPage],
  ] as const) {
    const { unmount } = render(<Page />);
    const hits = composeAnchors();
    console.log(name + ' 的发帖 href = ' + (hits.map((a) => a.getAttribute('href')).join(' | ') || '（无）'));
    expect(hits.length, name + ' 没有指向 18-compose 的链接').toBeGreaterThan(0);
    expect(
      hits.some((a) => (a.textContent ?? '').includes('发帖')),
      name + ' 的链接里没有「发帖」这个入口',
    ).toBe(true);
    unmount();
  }
});
