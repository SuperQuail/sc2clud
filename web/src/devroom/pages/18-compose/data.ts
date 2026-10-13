import { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { BOARDS as BOARD_LIST } from '@/devroom/pages/12-topic/mock';
import type { BoardSlug } from '@/devroom/pages/12-topic/types';
import { KIND_TAG, TOPIC_KIND_LABEL } from '@/devroom/pages/14-home/topic-kind';
import type { TopicKind } from '@/devroom/pages/14-home/mock';
import { MY_ACCOUNT, CANDIDATES } from '@/devroom/pages/12-topic/mock';

// 18-compose 的假数据。**全部从已有页面借来，本文件只补两样这里没有的东西**：
//   ① 标题上限（数据库设计 §4.2 topics.title = varchar(200)）；
//   ② 标签候选表（见下）。
// **待补接口**（回报里已写）：GET /api/v1/compose/options —— 字段校验、标签目录、正文与图片上限都该由服务端下发，
// 前端现在只是把 12-topic 的分区表搬过来。本轮是设计稿，不引 router、不 fetch。

/** 发帖选项：分区下拉直接用 12-topic 的分区表（同一个域，不许另编一套）。 */
export const BOARD_OPTIONS = BOARD_LIST.map((b) => ({ key: b.slug, label: b.name }));

export type BoardKey = BoardSlug;

/** 分区 slug → 中文名（预览与结果态要用；接口回来后由 options 携带，不再反查） */
export const BOARD_NAME = Object.fromEntries(BOARD_LIST.map((b) => [b.slug, b.name])) as Record<BoardKey, string>;

/** 预选分区：12-topic 页面展示的就是「自制战役」，从帖子页点发帖过来天然落在这里 */
export const DEFAULT_BOARD: BoardKey = 'custom-campaign';

/** 标题上限：数据库设计-postgresql.md §4.2 topics.title varchar(200) */
export const TITLE_MAX = 200;

/** 正文上限：与 09-rich 的帖子正文口径一致（帖子 20000 / 评论 10000） */
export const BODY_MAX = 20000;

/** 配图上限：与 09-rich 的 ImageUploader 默认一致 */
export const IMAGE_MAX = 10;

export type ComposeTag = 'resource' | 'discussion' | 'repost' | 'help' | 'announcement';

/** 标签候选表 —— **待补接口**：全站还没有标签目录（数据库里也没有 topic_tags 表）。
 *  这五个词不是新编的，是站点已有的内容类型词：前三个 = 12-topic/badges.tsx 与 14-home/topic-kind.ts
 *  的帖子类型（资源/讨论/转载）；「公告」= 12-topic/mock.ts 的 BOARD_NAV（announcement）；
 *  「求助」= 14-home/mock.ts 的 BOARDS（key: help，文案「求助答疑」）。
 *  （2026-10-13 核过：原先把「求助答疑」也记成 BOARD_NAV 的筛选，但 BOARD_NAV 只有
 *   全部/精华/资源/讨论/公告五项，没有求助 —— 出处改记到真正有它的那一处。）
 *  「求助」与「公告」没有 TopicKind 对应项，所以这里各写一份标签与配色（各自只有一处）。 */
export const TAGS: Array<{ key: ComposeTag; label: string; kind?: TopicKind; type: TagType }> = [
  { key: 'resource', label: TOPIC_KIND_LABEL.resource, kind: 'resource', type: KIND_TAG.resource },
  { key: 'discussion', label: TOPIC_KIND_LABEL.discussion, kind: 'discussion', type: KIND_TAG.discussion },
  { key: 'repost', label: TOPIC_KIND_LABEL.repost, kind: 'repost', type: KIND_TAG.repost },
  { key: 'help', label: '求助', type: TagType.WARNING },
  { key: 'announcement', label: '公告', type: TagType.ERROR },
];

/** 标签上限：三个够表达，再多就和分区信息重复了（后端也没有这个字段，属**待补接口**） */
export const TAG_MAX = 3;

const TAG_BY_KEY = Object.fromEntries(TAGS.map((t) => [t.key, t])) as Record<ComposeTag, (typeof TAGS)[number]>;

export function tagLabel(key: ComposeTag): string {
  return TAG_BY_KEY[key].label;
}

export function tagType(key: ComposeTag): TagType {
  return TAG_BY_KEY[key].type;
}

/** 帖子的图片是**正文节点**，不是独立字段（09-rich 已定：存储是 Lexical EditorState JSON）。
 *  所以这里的图片数组只是「正文里现在有几张图」的计数，真源永远是正文。 */
export const TAG_SUGGESTION_HINT = '最多挑 3 个；标签会显示在列表与帖子标题上。';

/** 写闸门未放行时给的那句话 —— **口径照 16-auth**（未激活可读不可写），不是另写一套。
 *  确认过 14-home 的文案（「注册只要一个昵称，发帖不用等审核」）与它不冲突：那句说的是**审核**，
 *  这里说的是**激活**，两根轴（后端开工前拍板 §9.4）。 */
export const NOT_ACTIVATED = {
  title: '未激活账号不能发帖',
  description:
    '你的账号还没激活（users.activated_at 为空）。激活前可以照常浏览、收藏与下载，发帖、回复、上传会被拦下并提示「需要先激活」。',
  hint: '激活入口在登录页：登录后会给「输入验证码」的位置，也可以让管理员帮你激活。',
  code: 'auth.not_activated',
  action: '去激活账号',
};

/** 当前登录者与 @ 提及候选：与 12-topic 共用同一份假名单（DevRoom-假数据规范） */
export const ME = MY_ACCOUNT;
export const MENTIONS = CANDIDATES;

/** 附件位支持的扩展名（**只做位置与提示，本轮不接上传**，见页面里的说明）。
 *  一号盲审抓到的矛盾：反馈帖写着「存档见附件（Replays 目录）」而全站只有图片上传控件——
 *  战役社区的命根子是 .SC2Map / .zip / 录像，所以这三类必须在提示里点名。 */
export const ATTACH_ACCEPT = '.SC2Map,.SC2MapMod,.zip,.rar,.7z,.SC2Replay,.rep,.txt,.md';
export const ATTACH_HINT = '支持 .SC2Map / .zip / .SC2Replay / .txt；单个 ≤ 20MB，最多 5 个。';

/** 审核口径（后端 §9 与 15-admin 的审核队列）：trusted 作者直接发布，其余进待审 */
export const REVIEW_HINT = {
  trusted: '你是被标记为 trusted 的作者，提交后**直接发布**，不进审核队列。',
  normal: '提交后进入待审队列，管理员通过后才对其他人生效；审核期间只有你自己能看到这篇。',
};
