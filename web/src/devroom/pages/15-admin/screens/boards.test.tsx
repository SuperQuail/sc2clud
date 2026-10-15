import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BoardsScreen, type BoardPatch } from './boards';
import type { AdminBoard } from '@/lib/api/admin';
import { DEFAULT_COVER_ART } from '@/ui/topic/default-cover';

// 分区封面的**换与清**（拍板 08 第二轮「壁纸替换」）在屏上到底发了什么。
//
// 为什么这条必须存在：上一版这一格只是一段说明文字（后端把空串折成 nil → 清空必然 400），
// 而**屏上就算画了清空按钮、patch 里没有 cover_hash 这一行也照样什么都不发** ——
// 「点了没反应」正是这么产生的。所以这里钉的是「点清空 → onSave 收到 {cover_hash:''}」，
// 不是「按钮在不在」。
function baseBoard(): AdminBoard {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    slug: 'campaign',
    name: '战役讨论',
    description: '简介',
    cover_hash: 'a'.repeat(64),
    status: 'active',
    acl_enabled: false,
    min_post_level: 0,
    position: 1,
    topic_count: 3,
    post_count: 5,
    today_count: 0,
    moderators: [],
  };
}

function renderScreen(onSave: (patch: Partial<BoardPatch>) => void, board: AdminBoard = baseBoard()) {
  render(
    <BoardsScreen
      boards={[board]}
      boardId={board.id}
      onSelect={() => {}}
      onSave={onSave}
      onMove={() => {}}
      roles={[]}
      acl={[]}
      onAclSave={() => {}}
      moderators={[]}
      candidates={[]}
      onGrantModerator={() => {}}
      onRevokeModerator={() => {}}
      onCreate={() => {}}
      onSetStatus={() => {}}
      onUploadCover={() => {}}
      canManage
    />,
  );
  return board;
}

it('清空封面：改的是 cover_hash，点保存时把它发出去（空串 = 置 NULL）', async () => {
  const seen: Array<Partial<BoardPatch>> = [];
  renderScreen((p) => seen.push(p));

  // 有封面时「清空封面」才画（没有封面就没有可清的）
  const clear = screen.getByRole('button', { name: '清空封面' });
  fireEvent.click(clear);

  // 草稿变了 → 保存按钮从「没有改动」变成「保存 1 项改动」（这就是"有效果"的第一半）
  const save = await screen.findByRole('button', { name: '保存 1 项改动' });
  fireEvent.click(save);
  await waitFor(() => expect(seen.length).toBe(1));
  expect(seen[0]).toEqual({ cover_hash: '' });
});

// D27（2026-10-15 用户实测「管理页分区管理稳定裂图」）：封面是**图片端点**的资源，只能走
// imagePath（/img/<hash>，会补 /dev 前缀）。旧行为用的是 assetUrl —— 那是 **public/art 静态素材**的
// 拼法（appPath('art/' + file)），于是地址成了 /art/img/<hash>：站上没有这条路径 → 稳定裂图，
// 而且因为它「看起来像一张图」，直到有人真的把这张图删掉才会暴露。
it('D27：封面图的地址是 imagePath 那条（/img/<裸哈希>），不是 assetUrl 的 /art/img/<哈希>', () => {
  renderScreen(() => {});
  const hash = 'a'.repeat(64);
  // 两处封面：列表行那一枚（32×32）与右侧「分区资料」里的预览（96×56）
  expect(document.querySelector('img[width="32"]')?.getAttribute('src')).toBe('/img/' + hash);
  expect(document.querySelector('img[width="96"]')?.getAttribute('src')).toBe('/img/' + hash);
});

// 没有封面时后台列表那一格原来是**一枚 ImageIcon 虚框**，看起来正好像「图裂了」。
// 用户 2026-10-15 的口径：没有封面就落那张默认封面图，四处一个样（@/ui/topic/default-cover）。
it('没有封面的分区：列表行与资料预览两处都落默认封面图，不是虚框也不是裂图', () => {
  const board: AdminBoard = { ...baseBoard(), cover_hash: '' };
  renderScreen(() => {}, board);
  const srcs = Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src'));
  // 两处缩略图都是同一张静态素材（assetUrl → /art/…），而不是 /img/ 那条图片端点
  expect(srcs.filter((s) => s === '/art/' + DEFAULT_COVER_ART)).toHaveLength(2);
  // 也没有第二张 /img/ 的图（没有封面时不该去要图片端点）
  expect(srcs.some((s) => s?.startsWith('/img/'))).toBe(false);
});

it('换封面：换了图也不进「未保存的改动」（它走图片通道，选完即生效）', async () => {
  const seen: Array<Partial<BoardPatch>> = [];
  renderScreen((p) => seen.push(p));
  // 这颗是 image-uploader 的 cover 形态（真站上它无条件画：onUploadCover 一定给）
  const pick = screen.getByRole('button', { name: '更换封面' });
  expect(pick).toBeTruthy();
  // 没有改动：保存按钮仍然是「没有改动」（封面不走草稿 → 不存在"点了没反应"的中间态）
  fireEvent.click(pick);
  expect(seen.length).toBe(0);
  expect(screen.getByRole('button', { name: '没有改动' })).toBeTruthy();
});
