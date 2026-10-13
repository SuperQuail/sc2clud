import { useState } from 'react';
import { appPath } from '@/lib/url';
import { TopicTaskTabs, type TopicTaskTab } from './_task/task-tabs';
import { AuthorCard } from './author-card';
import { BoardSummary } from './board-summary';
import { DesignActionNote } from './design-action';
import { EditTopicDialog } from './edit-dialog';
import { IssueNudge } from './issue-nudge';
import { LeftRail } from './left-rail';
import { MainColumn, TopicMeta } from './main-column';
import { AUTHOR, BOARDS, BOARD_NAV, CANDIDATES, CHANNELS, MY_ACCOUNT, topicBody, topicComments } from './mock';
import { REPORT_REASON_LABEL, ReportDialog } from './report-dialog';
import { AuthorOnlyHint, ReviewAppealButton, ReviewResubmitButton, ReviewStateDemoBar, type ReviewState } from './review-state';
import { RewardPanel } from './reward-panel';
import { TopicTaskShowcase } from './_task/showcase';
import type { CommentData } from '@/ui/comment/types';
import type { ReportItem } from '../15-admin/mock';
import type { TopicDetail, TopicSource } from './types';
import { roomHref } from '@/devroom/room-links';

// DevRoom 12 · 帖子内容页（贴吧式三栏）
//
// 结构：顶部两个大按钮（帖子内容 / 问题反馈，来自 _task/task-tabs）→ 三栏
//   左栏 分区列表 + 分区内导航（**只在 ≥1200px 出现**，贴吧式常驻栏）
//   中栏 帖子全文 + 下载来源 + 动作条 + 评论区（评论区复用 @/ui/comment，不另写一套）
//   右栏 分区简介 → 发帖者卡片 → 赞助入口 → 问题反馈入口
//
// 三档响应式：<768 单列／768–1279 两栏（左栏仍不出现）／≥1280 三栏。
// 页宽不再由本页自己挣：DevRoom 与真实壳（src/app/shell.tsx）**都是 max-w-[1280px]**，
// 所以这里量到的列宽就是真站的列宽（此前房间锁 1100px，页面靠负边距外扩，量出来的数不作数）。
//
// 本页是这一轮修的**三条断链**的落点（盲审二号 ③ / 13 与真缺陷 4/5/6）：
//   举报 → 弹层（事由单选，值域照 reports.reason）→ 提交后按钮变「已举报」+ 回执，
//          回执里的说法与管理队列（15-admin 举报处理）同一套：事由文案 / 待处理；
//   编辑 → 动作条上的「编辑」（post.update_own）→ 存完标题、正文、「最后编辑」就地变；
//          未通过审核时横幅上的「重新提交审核」把状态送回 pending
//          （原来那句「你可以修改后重新提交」没有任何落点）；
//   发布 / 删除回复 → 评论数真的 +1 / -1，列表里真的多一条 / 留下「该回复已删除」
//          （原来点「发布」文本原地不动、评论数仍是 54 那种状态）。

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
const ME_PERMS = ['post.update_own'];

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
const DESIGN_NOTE = '设计稿：这个按钮还没接线，点了不会有别的动作。';

/** ?review=… —— 只影响 DevRoom 的初始态，非法值一律按 pending（= 最需要看的那一态）。
 *  pending-human = 审核中且已转人工（同一态的第二档文案）。
 *  另外三个只给截图用的初值：report / edit / receipt=design —— 省掉一次点击，出图脚本能直接拍到交互态。 */
function readReviewFromUrl(): { state: ReviewState; pendingHuman: boolean } {
  const v = new URLSearchParams(location.search).get('review');
  if (v === 'approved' || v === 'rejected' || v === 'pending') return { state: v, pendingHuman: false };
  if (v === 'pending-human') return { state: 'pending', pendingHuman: true };
  return { state: 'pending', pendingHuman: false };
}

export default function TopicPage() {
  const [tab, setTab] = useState<TopicTaskTab>('content');
  const [nav, setNav] = useState('all');
  const params = new URLSearchParams(location.search);

  // 帖子的可变部分：标题 / 正文 / 最后编辑时间（编辑入口真的改它，不是只弹个框）
  const [title, setTitle] = useState(TOPIC.title);
  const [bodyHtml, setBodyHtml] = useState(TOPIC.content_html);
  const [updatedAt, setUpdatedAt] = useState(TOPIC.updated_at);
  // 评论：列表与总数都是这一页的状态。「发布」真的插一条、计数真的 +1
  const [comments, setComments] = useState<CommentData[]>(() => topicComments());
  const [commentTotal, setCommentTotal] = useState(TOPIC.reply_count);
  const [newCommentSeqs, setNewCommentSeqs] = useState<Record<string, number>>({});
  // 举报：帖子级一条状态 + 每条评论各自一条。提交后按钮变「已举报」，再点打开同一张弹层
  // （后端是幂等的：同一人对同一对象重复举报返回 200 + 既有那条，接口需求 §U5）
  const [reported, setReported] = useState<string | null>(() => (params.get('reported') === '1' ? 'spam' : null));
  const [reportedIds, setReportedIds] = useState<string[]>([]);
  const [reportTarget, setReportTarget] = useState<{ id: string; label: string } | null>(null);

  // 弹层与回执（?report=1 / ?edit=1 / ?receipt=design 是给截图用的初值）
  const [reportOpen, setReportOpen] = useState(() => params.get('report') === '1');
  const [editOpen, setEditOpen] = useState(() => params.get('edit') === '1');
  const [receipt, setReceipt] = useState<string | null>(() => (params.get('receipt') === 'design' ? DESIGN_NOTE : null));

  // DevRoom 演示用：真实页面读后端返回的 review_state，没有这个开关（见 review-state.tsx 的注释）。
  // 初值可以走 URL（?review=pending|approved|rejected），这样每一态都能单独出图、也能分享链接。
  const [reviewState, setReviewState] = useState<ReviewState>(() => readReviewFromUrl().state);
  // 后端 review_pending_human：pending 时的两档文案（自动检查 / 已转人工）
  const [pendingHuman, setPendingHuman] = useState(() => readReviewFromUrl().pendingHuman);
  const [appealed, setAppealed] = useState(false);
  // 共享件的验证现场仍要能打开：page=12-topic&view=showcase。
  // 独立入口（一个只挂着 showroom 的 index）被删掉了——同一页两个身份，出图时会看不出谁是主页面。
  const showcase = params.get('view') === 'showcase';

  // 权限点 post.update_own 只覆盖「自己的帖子」；作者本人 = 当前登录者与帖子的 author 是同一人。
  // mock 里当前登录者就是作者（AUTHOR 与 MY_ACCOUNT 同名同 handle），与 15-admin 的权限表一致。
  const isAuthor = MY_ACCOUNT.handle === AUTHOR.handle;
  const canEdit = ME_PERMS.includes('post.update_own') && isAuthor;

  const topic: TopicDetail = { ...TOPIC, title, content_html: bodyHtml, updated_at: updatedAt, reply_count: commentTotal };

  /** 举报提交：**必须给出可观察的结果**——按钮变「已举报」+ 一行回执。
   *  回执里的说法与 15-admin「举报处理」队列逐字对得上（事由文案 = REPORT_REASON 那五个、状态 = 待处理）。 */
  function submitReport(reason: ReportItem['reason'], detail: string) {
    const label = REPORT_REASON_LABEL[reason];
    if (reportTarget) {
      // 回复级举报（target_type=post）
      setReportedIds((ids) => (ids.includes(reportTarget.id) ? ids : [...ids, reportTarget.id]));
      setReceipt('已举报「' + reportTarget.label + '」 · 事由：' + label + ' · 已进「举报处理」队列的待处理' + (detail ? '（含补充说明）' : ''));
    } else {
      // 帖子级举报（target_type=topic）
      setReported(reason);
      setReceipt('已举报这篇帖子 · 事由：' + label + ' · 已进「举报处理」队列的待处理' + (detail ? '（含补充说明）' : ''));
    }
    setReportTarget(null);
    setReportOpen(false);
  }

  function openReport(target: { id: string; label: string } | null) {
    setReportTarget(target);
    setReportOpen(true);
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
   *  删帖与删回复是两个动作：这里只做「删回复」，帖子级的删除不在本页（管理侧另有入口）。 */
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
    setReceipt('这条回复已删除（本页是本地状态；真接线走后端软删，正文变成「该回复已删除」）');
  }

  function voteComment(id: string, value: 1 | -1) {
    setComments((list) =>
      list.map((c) => {
        const target = c.id === id ? c : c.replies?.items.find((r) => r.id === id);
        if (!target) return c;
        // 同向再点 = 取消（与契约的幂等 PUT / DELETE 一致）
        const next: CommentData =
          value === 1
            ? { ...target, likes: target.liked ? target.likes - 1 : target.likes + 1, liked: !target.liked, disliked: false, dislikes: target.disliked ? target.dislikes - 1 : target.dislikes }
            : { ...target, dislikes: target.disliked ? target.dislikes - 1 : target.dislikes + 1, disliked: !target.disliked, liked: false, likes: target.liked ? target.likes - 1 : target.likes };
        return c.id === id ? next : { ...c, replies: c.replies ? { ...c.replies, items: c.replies.items.map((r) => (r.id === id ? next : r)) } : c.replies };
      }),
    );
  }

  /** 编辑保存：标题 / 正文 / 最后编辑时间就地变。未通过审核时**顺手把它送回审核队列**——
   *  rejected 的唯一出路就是「改完重新提交」（后端状态机没有 rejected → approved 这条边）。 */
  function saveEdit(next: { title: string; text: string }) {
    setTitle(next.title);
    setBodyHtml(toHtml(next.text));
    setUpdatedAt('刚刚');
    setEditOpen(false);
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
        onDesignAction={() => setReceipt(DESIGN_NOTE)}
        appealNote={appealed ? APPEAL_SENT : null}
      />

      <TopicTaskTabs
        value={tab}
        onChange={setTab}
        issueCount={ISSUE_OPEN_COUNT}
        onOpenIssue={() => {
          // devroom 里没有路由：用一次跳转模拟「去反馈页」。（真页面走 react-router 的 navigate）
          window.location.assign(roomHref('13-issue'));
        }}
      />

      <div className='grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-[minmax(0,1fr)_248px] xl:flex xl:items-start'>
        {/* 左栏：只在 ≥1200px 出现。用 hidden 而不是挪到底部——它是「常驻栏」，不该在窄屏抢首屏 */}
        <aside aria-label='分区与分区内导航' className='hidden xl:block xl:w-[200px] xl:shrink-0'>
          <LeftRail boards={BOARDS} currentSlug={BOARD.slug} nav={BOARD_NAV} navValue={nav} onNavChange={setNav} />
        </aside>

        {/* 中栏：主区。窄屏靠 row-start 抢回第一格，右栏因此落在它下面、评论之前 */}
        <main data-testid='topic-main' className='flex min-w-0 flex-col gap-3 md:col-start-1 md:row-start-1 xl:flex-1'>
          <TopicMeta topic={topic} />
          <MainColumn
            topic={topic}
            comments={comments}
            commentTotal={commentTotal}
            candidates={CANDIDATES}
            me={MY_ACCOUNT}
            issueCount={ISSUE_OPEN_COUNT}
            reviewState={reviewState}
            reviewPendingHuman={pendingHuman}
            reviewNote={reviewState === 'rejected' ? REVIEW_NOTE_REJECTED : null}
            reviewAppeal={
              reviewState === 'rejected' ? (
                <ReviewAppealButton
                  onAppeal={() => {
                    setAppealed(true);
                    setReceipt(APPEAL_SENT);
                  }}
                />
              ) : null
            }
            reviewResubmit={
              reviewState === 'rejected' ? (
                <ReviewResubmitButton
                  onResubmit={() => {
                    setReviewState('pending');
                    setPendingHuman(false);
                    setReceipt('已重新提交审核 · 回到「审核中」，通过后其他人才能看到');
                  }}
                />
              ) : null
            }
            reported={reported !== null}
            canEdit={canEdit}
            onCopyLink={copyLink}
            onReport={() => openReport(null)}
            onEdit={() => setEditOpen(true)}
            onVote={voteComment}
            onDeleteComment={deleteComment}
            onSubmitComment={submitComment}
            reportedIds={reportedIds}
            onReportComment={(t) => openReport(t)}
            newSeqs={newCommentSeqs}
            receipt={receipt ? <DesignActionNote message={receipt} /> : null}
            reportDialog={
              reportOpen ? (
                <ReportDialog
                  targetLabel={
                    reportTarget
                      ? reportTarget.label
                      : '帖子 · ' + topic.title + (reported ? '（已举报过：' + REPORT_REASON_LABEL[reported as ReportItem['reason']] + '）' : '')
                  }
                  onSubmit={submitReport}
                  onClose={() => setReportOpen(false)}
                />
              ) : null
            }
            editDialog={
              editOpen ? (
                <EditTopicDialog title={title} text={toText(bodyHtml)} onSave={saveEdit} onClose={() => setEditOpen(false)} />
              ) : null
            }
          />
          {/* 「只有作者能看到」的说明放在卡片外、动作条与评论区之后：
              它是这一屏的注解，不是正文的一部分；正文与评论区照常渲染（作者当然能看自己的）。
              approved 时不渲染——正常帖没有这句话可说。 */}
          {reviewState === 'approved' ? null : <AuthorOnlyHint />}
        </main>

        {/* 右栏：分区简介 → 发帖者卡片 → 赞助 → 问题反馈入口。长帖里跟着滚 */}
        <aside
          data-testid='topic-rail'
          className='flex min-w-0 flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1 xl:sticky xl:top-4 xl:w-[248px] xl:shrink-0'
        >
          <BoardSummary board={BOARD} />
          <AuthorCard author={AUTHOR} />
          <RewardPanel channels={CHANNELS} />
          <IssueNudge variant='rail' issueCount={ISSUE_OPEN_COUNT} />
        </aside>
      </div>

      {showcase ? <TopicTaskShowcase /> : null}
    </div>
  );
}

/** 存下来的正文是纯文本（段落之间空一行），渲染前转成后端 content_html 的样子（已清洗的富文本）。 */
function toHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => '<p>' + escapeHtml(p.replace(/\n/g, ' ')) + '</p>')
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 编辑弹层的初值：从 content_html 剥标签得到纯文本（块级标签的收尾当段落分隔）。 */
function toText(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote)>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
