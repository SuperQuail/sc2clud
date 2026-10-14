import { expect, it } from 'vitest';
import type { Board as ApiBoard, TopicDetail as ApiTopicDetail } from '@/lib/api/forum';
import type { UserProfile } from '@/lib/api/user';
import { toDesignAuthor, toDesignBoard, toDesignSource, toDesignTopic, toReview } from './topic';

// 这一条盯的是**字段名**（不是逻辑）：契约两侧各写一份、两边测试都过、序列化那一层没人测 ——
// 这样栽过 6 次（board/board_id、captcha/captcha_answer、login/username、parent_id、hot、post.create）。
// 所以这里的输入是**实测的线格式**（shots/blindtest/_api-shapes.json 的 topic_detail + forum/internal/forum/dto.go），
// 断言的是设计件吃到的形状。字段名一改，这条就红。

/** @/dev/api/v1/topics/{id} 实测回来的那一份（照抄 Go 的 TopicDetailDTO：时间 RFC3339、头像裸哈希、featured 不是 featured_at）。 */
const WIRE = {
  id: '01a13540-ff54-7f07-a975-51e08a5f831c',
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明',
  excerpt: '这是正文摘要',
  board: { slug: 'custom-campaign', name: '自制战役' },
  author: { handle: 'Alenger', nickname: '爱兰琪尔', avatar_hash: 'a1b2c3', avatar_small_hash: 'd4e5f6' },
  content_md: '正文',
  content_html: '<p>正文</p>',
  created_at: '2026-10-08T06:35:53Z',
  updated_at: '2026-10-13T12:25:08Z',
  last_reply_at: '2026-10-13T12:25:08Z',
  reply_count: 1,
  like_count: 1,
  view_count: 6,
  issue_open_count: 7,
  review_state: 'rejected',
  review_note: '正文含未标明来源的下载地址',
  can_edit: true,
  can_reply: false,
  featured: true,
  pinned: true,
  locked: false,
  viewer: { liked: true, bookmarked: false },
  sources: [
    {
      id: 's1',
      provider: 'pan123',
      label: '第三章整合包',
      go_path: '/api/v1/topics/01a13540/sources/s1/go',
      url: 'https://example.invalid/x',
      extraction_code: 'c2c',
      size: '2.4 GB',
      upkeep: 'archived',
      verified_at: '2026-10-12T01:20:00Z',
    },
  ],
} as unknown as ApiTopicDetail;

/** GET /dev/api/v1/users/{handle} 实测（user.Profile：平铺，没有 stats 子对象）。 */
const PROFILE = {
  handle: 'Alenger',
  nickname: '爱兰琪尔',
  avatar: '/img/a1b2c3',
  bio: '战役作者',
  status: 'active',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024-03-01T00:00:00Z',
  title: { name: '执政官', color: '#2563eb' },
} as unknown as UserProfile;

it('详情 → 设计件：正文、时间、精华、审核态、我的三态都取对了字段', () => {
  const author = toDesignAuthor(WIRE, PROFILE);
  const t = toDesignTopic(WIRE, author);
  expect(t.id).toBe(WIRE.id);
  expect(t.board.slug).toBe('custom-campaign');
  expect(t.content_html).toBe('<p>正文</p>');
  // 时间线格式是 RFC3339 → 展示串（不是原样塞进去）
  expect(t.created_at).not.toBe(WIRE.created_at);
  expect(t.created_at.length).toBeGreaterThan(0);
  // 详情用 featured（列表项才叫 featured_at）——按 featured_at 读会永远为 false，精华标就丢了
  expect(t.featured).toBe(true);
  expect(t.pinned).toBe(true);
  expect(t.viewer).toEqual({ liked: true, bookmarked: false, following: false });
  // 只有作者看得到的理由
  expect(toReview(WIRE)).toEqual({ state: 'rejected', pendingHuman: false, note: '正文含未标明来源的下载地址' });
});

it('作者：头像取 avatar_hash 拼成 /img/<hash>，等级/经验/头衔取用户域那一份', () => {
  const a = toDesignAuthor(WIRE, PROFILE);
  expect(a.handle).toBe('Alenger');
  expect(a.avatar).toContain('/img/a1b2c3');
  expect(a.level).toBe(27);
  expect(a.exp).toBe(640);
  expect(a.exp_max).toBe(1000);
  expect(a.topic_count).toBe(86);
  expect(a.like_received).toBe(12480);
  expect(a.title).toEqual({ name: '执政官', color: '#2563eb' });
  // 用户域没回来时也不能崩（头像回落空串，等级回落 1）
  const bare = toDesignAuthor(WIRE, undefined);
  expect(bare.avatar).toContain('/img/a1b2c3');
  expect(bare.level).toBe(1);
});

it('下载来源：provider 是开放词表（不许收窄成两个），go_path 过 appPath，归档状态照搬', () => {
  const s = toDesignSource(WIRE.sources![0]!);
  expect(s.provider).toBe('pan123');
  expect(s.id).toBe('s1');
  expect(s.extraction_code).toBe('c2c');
  expect(s.upkeep).toBe('archived');
  // 后端回的是**站根绝对地址** /api/v1/...（不带 /dev 前缀），必须过 appPath 才能同时在 / 与 /dev/ 下跑。
  // **不能用 endsWith**：那样丢了前缀（点下去跳站外 404）也是绿的，见 lib/url.test.ts 那条。
  expect(s.go_path).toBe('/api/v1/topics/01a13540/sources/s1/go');
  expect(s.verified_at).not.toBe('2026-10-12T01:20:00Z');
});

it('分区：后端 BoardDTO 没有 member_count / hint / joined，缺的按 0 与 false 兜底而不是伪造', () => {
  const b = toDesignBoard({
    slug: 'custom-campaign',
    name: '自制战役',
    description: '玩家自制战役',
    cover: null,
    topic_count: 12,
    post_count: 30,
    today_count: 1,
  } as ApiBoard);
  expect(b.slug).toBe('custom-campaign');
  expect(b.cover).toBe('');
  expect(b.topic_count).toBe(12);
  expect(b.post_count).toBe(30);
  expect(b.member_count).toBe(0);
  expect(b.joined).toBe(false);
  expect(b.hint).toBe('');
});
