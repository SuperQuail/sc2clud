import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import IssuePage from './index';

// 页面级冒烟测试：只断言「用户看得见的东西」——列表、详情、评论区（复用 @/ui/comment）、空状态、新建入口。
// 交互闭环（新建反馈 / 发评论当场出现）在真浏览器里出图看；这里守的是「整页能渲染、关键件没掉」。
describe('13-issue 页面', () => {
  it('默认展示列表与第一条详情，评论区来自 @/ui/comment', () => {
    render(<IssuePage />);
    expect(screen.getByRole('region', { name: '反馈列表' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /第三章隐藏结局/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /评论/ })).toBeTruthy();
    expect(screen.getByLabelText('正文')).toBeTruthy();
  });

  it('四个新建入口都在，且是可键盘操作的按钮', () => {
    render(<IssuePage />);
    for (const label of ['汇报 Bug', '功能建议', '难度建议', '其他反馈']) {
      expect(screen.getAllByRole('button', { name: new RegExp('^' + label) }).length).toBeGreaterThan(0);
    }
  });

  it('检索限定词能过滤列表，搜不到时给空状态', () => {
    render(<IssuePage />);
    const list = screen.getByRole('region', { name: '反馈列表' });
    const box = screen.getByLabelText('搜索反馈');

    fireEvent.change(box, { target: { value: 'kind:feature' } });
    // 行本身也是 button（点击容器），所以按 aria-label 前缀把行挑出来
    const rowLabels = () =>
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((l) => l.startsWith('打开反馈'));
    expect(rowLabels()).toHaveLength(1); // 当前在「开启中」分类，feature 只剩这一条
    expect(rowLabels().join('|')).toContain('希望支持把整章地图');
    expect(rowLabels().join('|')).not.toContain('第三章隐藏结局');

    // 限定词与分类 tab 是 AND：切到「已关闭」就能看到那条 closed 的 feature
    fireEvent.click(screen.getByRole('button', { name: /已关闭/ }));
    expect(rowLabels().join('|')).toContain('帖子支持 Markdown 表格');

    fireEvent.change(box, { target: { value: '肯定搜不到的词' } });
    expect(within(list).getByText('没有符合条件的反馈')).toBeTruthy();
  });

  // 用户可见处不许漏内部串（第三轮拍板后的排查）：裸枚举、代码路径都不该出现在页面上。
  // 判据是**整页可见文字** —— 用户看到的就是这一整片字；分条断言便于一眼看出漏的是哪一类。
  it('用户可见处不泄漏内部串：没有裸枚举 Open/Closed、没有 @/ 代码路径', () => {
    render(<IssuePage />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('@/');
    expect(text).not.toMatch(/\bOpen\b/);
    expect(text).not.toMatch(/\bClosed\b/);
    // 检索框下那一行是**给用户看的检索语法**（保留），但它必须自报家门，不能读成漏出来的枚举
    expect(text).toContain('检索语法');
  });

  it('点列表项切换详情，点详情里的「收起详情」回到空态', () => {
    render(<IssuePage />);
    const list = screen.getByRole('region', { name: '反馈列表' });
    const target = within(list)
      .getAllByRole('button')
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('希望支持把整章地图'));
    expect(target).toBeTruthy();
    fireEvent.click(target!);
    expect(screen.getByRole('heading', { name: /希望支持把整章地图/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起详情' }));
    expect(screen.getByText('从左边选一条反馈看详情')).toBeTruthy();
  });
});
