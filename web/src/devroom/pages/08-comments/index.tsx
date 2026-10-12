import { assetUrl } from '@/lib/url';
import { CommentActions } from '@/ui/comment/comment-actions';
import { CommentItem } from '@/ui/comment/comment-item';
import { CommentList } from '@/ui/comment/comment-list';
import { CommentReplies } from '@/ui/comment/comment-replies';
import { ReplyBox } from '@/ui/comment/reply-box';
import type { CommentData } from '@/ui/comment/types';
import { Card, Row } from '@/devroom/kit';

// DevRoom 08 · 评论区（参考 B 站评论区结构）
// 拆成小控件：CommentList（区块）/ CommentItem（一条）/ CommentActions（动作行）/
// CommentReplies（楼中楼）/ ReplyBox（回复框）。
// **可复用的一律复用**：身份用 src/ui/user/*，按钮用 Ring UI Button，回复框用 Ring UI Input(multiline)。
const A = (p: string) => assetUrl(p);

const TANG = {
  handle: 'tangtian',
  nickname: '唐天',
  avatar: A('miyin-portrait-320.webp'),
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
const LIN = { handle: 'linshi', nickname: '林诗', avatar: A('miyin-chibi-160.webp'), role: { key: 'creator', name: '认证创作者' } };
const XIAO = { handle: 'xiaox', nickname: '某小X' };

const REPLIES: CommentData[] = [
  {
    id: 'r1',
    author: LIN,
    body: '这个思路对，但要注意前置依赖；我上次直接覆盖 Maps 目录，结果旧存档读不出来。',
    createdAt: '2026-09-28 12:25',
    likes: 3,
    dislikes: 0,
    likes2: 0,
  } as CommentData,
  {
    id: 'r2',
    author: TANG,
    body: '临时起意',
    createdAt: '2026-09-28 14:43',
    likes: 1,
    dislikes: 0,
    op: true,
    mutual: true,
  },
];

const ME = { nickname: '唐天', avatar: A('miyin-portrait-320.webp') };

const COMMENTS: CommentData[] = [
  {
    id: 'c1',
    author: XIAO,
    body: '？为什么不叫我',
    createdAt: '2026-09-28 12:25',
    likes: 12,
    dislikes: 0,
    mutual: true,
    replies: { total: 3, items: REPLIES, previewCount: 2 },
  },
  {
    id: 'c2',
    author: TANG,
    body: '第三章已经发了，18 张地图，三个结局。装过第二章的直接进游戏就行，存档兼容。',
    createdAt: '2026-09-28 09:10',
    likes: 48,
    dislikes: 1,
    liked: true,
    op: true,
    replies: { total: 1, items: [REPLIES[0]!], previewCount: 2 },
  },
];

export default function CommentsPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='评论区（整块 · CommentList）'
        note='对照 B 站：表头「评论 N」+ 最热｜最新，下面常驻评论框；楼中楼不加竖线，靠缩进与间距表达层级。'
      >
        <CommentList comments={COMMENTS} total={54} me={ME} />
      </Card>

      <Card
        name='拆出来的小控件（每个都能单独复用）'
        note='这块是为了看清拆分：动作行 / 一条评论 / 楼中楼 / 回复框，各自独立。'
      >
        <Row label='CommentActions（动作行）' hint='复用 Ring UI Button（ghost）＋ lucide 图标经 icon16 包装'>
          <CommentActions likes={12} dislikes={0} />
          <CommentActions likes={48} dislikes={1} liked replyLabel='回复楼主' />
        </Row>
        <Row label='CommentItem（一条评论）' hint='身份部分全部复用 src/ui/user（头像/用户名/权限/头衔）'>
          <div className='w-full max-w-xl'>
            <CommentItem comment={COMMENTS[1]!} />
          </div>
        </Row>
        <Row label='CommentReplies（楼中楼）' hint='默认显示 2 条，其余用 Button 展开；左侧竖线表达层级'>
          <div className='w-full max-w-xl'>
            <CommentReplies replies={{ total: 5, items: REPLIES, previewCount: 2 }} />
          </div>
        </Row>
        <Row label='ReplyBox（回复框）' hint='复用 Ring UI Input（multiline + autogrow + 高度 L，能写长评论）；只有一个发布按钮，空内容不可点'>
          <div className='w-full max-w-xl'>
            <ReplyBox me={ME} replyingTo='某小X' />
          </div>
        </Row>
      </Card>

      <Card name='待补' note='这些还没做，先记着。'>
        <Row label='未做' hint='不做出来不许进业务页面'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>@ 提及选择器</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>表情/图片</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>折叠长评论（阅读更多）</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>举报菜单</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>分页/加载更多</span>
        </Row>
      </Card>
    </div>
  );
}
