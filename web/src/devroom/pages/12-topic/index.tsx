import { useState } from 'react';
import { appPath } from '@/lib/url';
import { roomHref } from '@/devroom/room-links';
import type { CommentData } from '@/ui/comment/types';
import { DESIGN_ACTION_NOTE, DesignActionNote } from './design-action';
import { REPORT_REASON_LABEL } from './report-dialog';
import { AUTHOR, BOARDS, BOARD_NAV, CANDIDATES, CHANNELS, MY_ACCOUNT, TOPIC_CONTENT_MD, topicBody, topicComments } from './mock';
import { ReviewStateDemoBar, type ReviewState } from './review-state';
import { TopicView, type TopicReview } from './topic-view';
import { TopicTaskShowcase } from './_task/showcase';
import type { TopicDetail, TopicSource } from './types';
import type { ReportReason } from '@/lib/api/forum';

// DevRoom 12 · 帖子内容页（贴吧式三栏）
//
// 这一份只做**房间宿主**：拿 mock 造数据、把动作接成本地状态、上面挂一排「审核态演示」控件。
// 版面本身在 topic-view.tsx（prop 驱动），真站 src/routes/topic.tsx 渲染的是同一个组件 ——
// 房间与真站不会再各长一份版式。
//
// 三档响应式：<768 单列／768–1279 两栏（左栏仍不出现）／≥1280 三栏。
// 页宽不再由本页自己挣：DevRoom 与真实壳（src/app/shell.tsx）**都是 max-w-[1280px]**，
// 所以这里量到的列宽就是真站的列宽（此前房间锁 1100px，页面靠负边距外扩，量出来的数不作数）。
//
// 本页是这一轮修的**三条断链**的落点（盲审二号 ③ / 13 与真缺陷 4/5/6）：
//   举报 → 弹层（事由单选，值域照 reports.reason）→ 提交后按钮变「已举报」+ 回执，
//          回执里的说法与管理队列（15-admin 举报处理）同一套：事由文案 / 待处理；
//   编辑 → 动作条上的「编辑」（topic.edit.own）→ 存完标题、正文、「最后编辑」就地变；
//          未通过审核时横幅上的「重新提交审核」把状态送回 pending
//          （原来那句「你可以修改后重新提交」没有任何落点）；
//   发布 / 删除回复 → 评论数真的 +1 / -1，列表里真的多一条 / 留下「该回复已删除」。

const BOARD = BOARDS.find((b) => b.slug === 'custom-campaign') ?? BOARDS[0]!;

// 下载来源：go_path 走服务端转链端点（后端 §21.2 的 assets/go 同款形状），前端不暴露真实直链
const SOURCES: TopicSource[] = [
  {
    id: 's1',
    provider: 'netdisk',
    label: '第三章整合包（含 18 张地图 + 完整语音）',
    go_path: appPath('api/v1/topics/t_1042/sources/s1/go'),
    extraction_code: 'sc2c',
    size: '2.4 GB',
    verified_at: '今天 09:20',
    upkeep: 'active',
  },
  {
    id: 's2',
    provider: 'github',
    label: '触发器源码与本地化文本（MIT）',
    go_path: appPath('api/v1/topics/t_1042/sources/s2/go'),
    extraction_code: null,
    size: '18 MB',
    verified_at: '3 天前',
    upkeep: 'active',
  },
  {
    id: 's3',
    provider: 'netdisk',
    label: '旧版第二章补丁（仅存档修复用）',
    go_path: appPath('api/v1/topics/t_1042/sources/s3/go'),
    extraction_code: 'c2fix',
    size: '64 MB',
    verified_at: '2026-08-30',
    upkeep: 'archived',
  },
];

const TOPIC: TopicDetail = {
  id: 't_1042',
  board: { slug: 'custom-campaign', name: '自制战役' },
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明：菌毯推进速度与第 11 关调整',
  content_html: topicBody(),
  // 正文真源：编辑弹层把它灌回 MarkdownEditor（房间的 topicBody 是手写 HTML，反推不回编辑器状态）
  content_md: TOPIC_CONTENT_MD,
  author: AUTHOR,
  created_at: '2026-10-12 09:20',
  updated_at: '今天 11:04',
  reply_count: 128,
  like_count: 236,
  view_count: 4203,
  bookmark_count: 74,
  pinned: true,
  featured: true,
  locked: false,
  sources: SOURCES,
  images: [],
  viewer: { liked: false, bookmarked: true, following: false },
};

/** 未关闭的 Issue 数：顶栏 Issue 按钮上的计数（真值来自 GET /api/v1/topics/{id}/issues?status=open） */
const ISSUE_OPEN_COUNT = 7;

/** 当前登录者持有的权限点（真实来源是 GET /api/v1/me 的 perms；本页只用到这一条）。
 *  没有它就不渲染「编辑」——前端权限只管「显不显示」，判定仍在后端（authz.Require）。 */
const ME_PERMS = ['topic.edit.own'];

/** 新发评论的序号：置顶与「最新」排序都靠它（mock 的 createdAt 是「3 小时前」这种展示串，排不了） */
let seq = 0;

// 审核理由原文：后端 topics.review_note（varchar(500)），AI 给的中文理由。
// **只在 rejected 时存在**——pending 没有理由，approved 会把它清空，所以这里不给默认值。
// 故意写成一条接近上限的长理由（评审要看长文案的换行表现，而不是看它有多整齐）
const REVIEW_NOTE_REJECTED =
  '正文含未标明来源的第三方整合包下载地址，且缺少「非官方」声明；' +
  '同时贴文里出现了「官网唯一指定下载」这类容易让人误认为是官方渠道的措辞，' +
  '并附带两个短链跳转与一个未备案的网盘口令。按站规第 3 条（推广与来源标注）判为推广内容：' +
  '请去掉「唯一指定」表述、标注「非官方整合」、把短链替换为可核对的原始地址后重新提交。';
const APPEAL_SENT = '已提交人工复核，队列里有记录（mock）。';

/** ?review=… —— 只影响 DevRoom 的初始态，非法值一律按 pending（= 最需要看的那一态）。
 *  pending-human = 审核中且已转人工（同一态的第二档文案）。
 *  另外几个只给截图用的初值：report / edit / receipt=design —— 省掉一次点击，出图脚本能直接拍到交互态。 */
function readReviewFromUrl(): { state: ReviewState; pendingHuman: boolean } {
  const v = new URLSearchParams(location.search).get('review');
  if (v === 'approved' || v === 'rejected' || v === 'pending') return { state: v, pendingHuman: false };
  if (v === 'pending-human') return { state: 'pending', pendingHuman: true };
  return { state: 'pending', pendingHuman: false };
}

export default function TopicPage() {
  const params = new URLSearchParams(location.search);

  // 帖子的可变部分：标题 / 正文 / 最后编辑时间（编辑入口真的改它，不是只弹个框）
  const [title, setTitle] = useState(TOPIC.title);
  const [bodyHtml, setBodyHtml] = useState(TOPIC.content_html);
  // 编辑器真源也要跟着状态走：编辑保存后 JSON 与 HTML 必须同时更新，
  // 否则再打开一次编辑框会看到**上一次的正文**（保存成功但内容没变的假象）。
  const [bodyMd, setBodyMd] = useState(TOPIC.content_md);
  const [updatedAt, setUpdatedAt] = useState(TOPIC.updated_at);
  // 点赞 / 收藏：两个可切换状态（真站是幂等 PUT/DELETE，这里是本地演示）
  const [liked, setLiked] = useState(TOPIC.viewer.liked);
  const [bookmarked, setBookmarked] = useState(TOPIC.viewer.bookmarked);
  // 评论：列表与总数都是这一页的状态。「发布」真的插一条、计数真的 +1
  const [comments, setComments] = useState<CommentData[]>(() => topicComments());
  const [commentTotal, setCommentTotal] = useState(TOPIC.reply_count);
  const [newCommentSeqs, setNewCommentSeqs] = useState<Record<string, number>>({});
  // 举报：帖子级一条状态 + 每条评论各自一条。提交后按钮变「已举报」，再点打开同一张弹层
  // （后端是幂等的：同一人对同一对象重复举报返回 200 + 既有那条，接口需求 §U5）
  const [reported, setReported] = useState(() => params.get('reported') === '1');
  const [reportedIds, setReportedIds] = useState<string[]>([]);
  // 分区内导航的选中项：房间里不真的筛（房间只有这一页），但**选中态要能动**，
  // 否则这一栏在房间里是个死控件，评审看不到它的选中样式。
  const [nav, setNav] = useState('all');
  // 回执（?receipt=design 是给截图用的初值）
  const [receipt, setReceipt] = useState<string | null>(() => (params.get('receipt') === 'design' ? DESIGN_ACTION_NOTE : null));

  // DevRoom 演示用：真实页面读后端返回的 review_state，没有这个开关（见 review-state.tsx 的注释）。
  // 初值可以走 URL（?review=pending|approved|rejected），这样每一态都能单独出图、也能分享链接。
  const [reviewState, setReviewState] = useState<ReviewState>(() => readReviewFromUrl().state);
  // 后端 review_pending_human：pending 时的两档文案（自动检查 / 已转人工）
  const [pendingHuman, setPendingHuman] = useState(() => readReviewFromUrl().pendingHuman);
  const [appealed, setAppealed] = useState(false);
  // 共享件的验证现场仍要能打开：page=12-topic&view=showcase。
  // 独立入口（一个只挂着 showroom 的 index）被删掉了——同一页两个身份，出图时会看不出谁是主页面。
  const showcase = params.get('view') === 'showcase';

  // 这一屏演示的是**作者视角**（真的帖子页里由后端 can_edit 决定：作者 + topic.edit.own + 没锁定）。
  // 别按 handle 相等去判：假名单隐私清理后 MY_ACCOUNT(demo-marine) 与 AUTHOR(demo-admin) 已经不是同一个人，
  // 于是「编辑」整颗按钮在房间里消失，编辑链路连同审核横幅的落点一起看不到（房间因此漏掉过一次验收）。
  const canEdit = ME_PERMS.includes('topic.edit.own');

  const topic: TopicDetail = { ...TOPIC, title, content_md: bodyMd, content_html: bodyHtml, updated_at: updatedAt, reply_count: commentTotal };
  const review: TopicReview = {
    state: reviewState,
    pendingHuman,
    note: reviewState === 'rejected' ? REVIEW_NOTE_REJECTED : null,
  };
  const likeCount = TOPIC.like_count + (liked === TOPIC.viewer.liked ? 0 : liked ? 1 : -1);
  const bookmarkCount = TOPIC.bookmark_count + (bookmarked === TOPIC.viewer.bookmarked ? 0 : bookmarked ? 1 : -1);

  /** 举报提交：**必须给出可观察的结果**——按钮变「已举报」+ 一行回执。
   *  回执里的说法与 15-admin「举报处理」队列逐字对得上（事由文案 = REPORT_REASON 那五个、状态 = 待处理）。 */
  function submitReport(reason: ReportReason, detail: string, target: { id: string; label: string } | null) {
    const label = REPORT_REASON_LABEL[reason];
    if (target) {
      // 回复级举报（后端 target_type=post）
      setReportedIds((ids) => (ids.includes(target.id) ? ids : [...ids, target.id]));
      setReceipt('已举报「' + target.label + '」 · 事由：' + label + ' · 已进「举报处理」队列的待处理' + (detail ? '（含补充说明）' : ''));
    } else {
      // 帖子级举报（后端 target_type=topic）
      setReported(true);
      setReceipt('已举报这篇帖子 · 事由：' + label + ' · 已进「举报处理」队列的待处理' + (detail ? '（含补充说明）' : ''));
    }
  }

  /** 发布：主楼插到最前，楼中楼插到它那条主楼下面。计数 +1。 */
  function submitComment(parentId: string | null, body: { json: string; html: string }) {
    const id = 'new-' + ++seq;
    const item: CommentData = {
      id,
      author: { handle: MY_ACCOUNT.handle, nickname: MY_ACCOUNT.nickname, avatar: MY_ACCOUNT.avatar, role: { key: 'creator', name: '认证创作者' } },
      body: body.html,
      createdAt: '刚刚',
      likes: 0,
      dislikes: 0,
    };
    setNewCommentSeqs((m) => ({ ...m, [id]: seq }));
    setComments((list) => {
      if (!parentId) return [item, ...list];
      return list.map((c) =>
        c.id === parentId
          ? { ...c, replies: { ...(c.replies ?? { total: 0, items: [] }), total: (c.replies?.total ?? 0) + 1, items: [...(c.replies?.items ?? []), item] } }
          : c,
      );
    });
    setCommentTotal((n) => n + 1);
    setReceipt('已发布 · 回复 #' + id + '（本页是本地状态，刷新即还原）');
  }

  /** 删除回复：**只删自己的**（非作者根本看不到那个按钮）。
   *  删帖与删回复是两个动作：这里只做「删回复」，帖子级的删除在动作条上另有入口。 */
  function deleteComment(parentId: string | null, id: string) {
    setComments((list) => {
      if (!parentId) return list.filter((c) => c.id !== id);
      return list.map((c) =>
        c.id === parentId
          ? { ...c, replies: c.replies ? { ...c.replies, total: Math.max(0, c.replies.total - 1), items: c.replies.items.filter((r) => r.id !== id) } : c.replies }
          : c,
      );
    });
    setCommentTotal((n) => Math.max(0, n - 1));
    setNewCommentSeqs((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    setReceipt('这条回复已删除，评论数已减 1（本页是本地状态，刷新即还原）');
  }

  function voteComment(id: string, value: 1 | -1) {
    setComments((list) =>
      list.map((c) => {
        const target = c.id === id ? c : c.replies?.items.find((r) => r.id === id);
        if (!target) return c;
        // 同向再点 = 取消（与契约的幂等 PUT / DELETE 一致）
        const next: CommentData =
          value === 1
            ? { ...target, likes: target.liked ? target.likes - 1 : target.likes + 1, liked: !target.liked, disliked: false, dislikes: target.disliked ? (target.dislikes ?? 0) - 1 : target.dislikes }
            : { ...target, dislikes: target.disliked ? (target.dislikes ?? 0) - 1 : (target.dislikes ?? 0) + 1, disliked: !target.disliked, liked: false, likes: target.liked ? target.likes - 1 : target.likes };
        return c.id === id ? next : { ...c, replies: c.replies ? { ...c.replies, items: c.replies.items.map((r) => (r.id === id ? next : r)) } : c.replies };
      }),
    );
  }

  /** 编辑保存：标题 / 正文 / 最后编辑时间就地变。未通过审核时**顺手把它送回审核队列**——
   *  rejected 的唯一出路就是「改完重新提交」（后端状态机没有 rejected → approved 这条边）。 */
  function saveEdit(next: { title: string; json: string; html: string }) {
    setTitle(next.title);
    // 真源与展示一起换：JSON 给「再编辑一次」，HTML 给正文渲染（后端这两列也是同一次写入）
    setBodyMd(next.json);
    setBodyHtml(next.html);
    setUpdatedAt('刚刚');
    if (reviewState === 'rejected') {
      setReviewState('pending');
      setPendingHuman(false);
      setReceipt('已保存并重新提交审核 · 回到「审核中」，通过后其他人才能看到');
    } else {
      setReceipt('已保存 · 「最后编辑」时间已更新为「刚刚」');
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      setReceipt('链接已复制：' + location.href);
    } catch {
      // 剪贴板没有权限（非 https / 用户拒绝）时给可复制的原文，仍然不是静默
      setReceipt('复制被浏览器挡下了，手动复制这个地址：' + location.href);
    }
  }

  return (
    <div className='flex w-full flex-col gap-4'>
      <ReviewStateDemoBar
        value={reviewState}
        pendingHuman={pendingHuman}
        onPendingHumanChange={setPendingHuman}
        onChange={(v) => {
          setReviewState(v);
          setAppealed(false);
        }}
        onAppeal={() => {
          setAppealed(true);
          setReceipt(APPEAL_SENT);
        }}
        onDesignAction={() => setReceipt(DESIGN_ACTION_NOTE)}
        appealNote={appealed ? APPEAL_SENT : null}
      />

      <TopicView
        boards={BOARDS}
        board={BOARD}
        boardNav={BOARD_NAV}
        boardHref={() => roomHref('12-topic')}
        navValue={nav}
        // 分区内导航在房间里没有落点（房间只有这一页）：切换只改高亮，选中态由本页记着
        onNavChange={setNav}
        composeHref={appPath('?page=18-compose&board=' + BOARD.slug)}
        authorHref={roomHref('11-profile')}
        author={AUTHOR}
        topic={topic}
        review={review}
        canEdit={canEdit}
        liked={liked}
        bookmarked={bookmarked}
        likeCount={likeCount}
        bookmarkCount={bookmarkCount}
        onToggleLike={() => setLiked((v) => !v)}
        onToggleBookmark={() => setBookmarked((v) => !v)}
        onCopyLink={copyLink}
        onEdit={saveEdit}
        onSubmitReport={submitReport}
        reported={reported}
        reportedIds={reportedIds}
        onDelete={() => setReceipt('已删除这篇帖子（本页是本地状态，刷新即还原）')}
        onAppeal={() => {
          setAppealed(true);
          setReceipt(APPEAL_SENT);
        }}
        onResubmit={() => {
          setReviewState('pending');
          setPendingHuman(false);
          setReceipt('已重新提交审核 · 回到「审核中」，通过后其他人才能看到');
        }}
        comments={comments}
        commentTotal={commentTotal}
        candidates={CANDIDATES}
        me={MY_ACCOUNT}
        newSeqs={newCommentSeqs}
        onSubmitComment={submitComment}
        onDeleteComment={deleteComment}
        onVoteComment={voteComment}
        channels={CHANNELS}
        issueCount={ISSUE_OPEN_COUNT}
        feedbackHref={roomHref('13-issue')}
        onOpenIssue={() => window.location.assign(roomHref('13-issue'))}
        receipt={receipt ? <DesignActionNote message={receipt} /> : null}
        initialLayer={params.get('open') === 'report' ? 'report' : params.get('open') === 'edit' ? 'edit' : undefined}
      />

      {showcase ? <TopicTaskShowcase /> : null}
    </div>
  );
}

// toHtml / escapeHtml 已删：它们服务的是「编辑框是纯文本框、正文是一段纯文本」的那个旧形态。
// 现在编辑走 MarkdownEditor，HTML 由编辑器（$generateHtmlFromNodes）给，后端再清洗一遍 ——
// 再留一份「纯文本 → HTML」的转换就是第二条会与它分叉的实现。
