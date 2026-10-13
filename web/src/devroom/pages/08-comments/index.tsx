import { useState } from 'react';
import { appPath, assetUrl } from '@/lib/url';
import { CommentActions } from '@/ui/comment/comment-actions';
import { CommentItem } from '@/ui/comment/comment-item';
import { CommentList } from '@/ui/comment/comment-list';
import { CommentReplies } from '@/ui/comment/comment-replies';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { ReplyBox } from '@/ui/comment/reply-box';
import type { CommentData } from '@/ui/comment/types';
import { Card, Row } from '@/devroom/kit';

// DevRoom 08 · 评论区（参考 B 站评论区结构）
// 拆成小控件：CommentList（区块）/ CommentItem（一条）/ CommentActions（动作行）/
// CommentReplies（楼中楼）/ ReplyBox（回复框）。
// **可复用的一律复用**：身份用 src/ui/user/*，按钮用 Ring UI Button，回复框用 Ring UI Input(multiline)。
const A = (p: string) => assetUrl(p);

const TANG = {
  handle: 'demo-admin',
  nickname: '示范管理员',
  avatar: A('miyin-portrait-320.webp'),
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
const LIN = { handle: 'demo-thor', nickname: '雷神', avatar: A('miyin-chibi-160.webp'), role: { key: 'creator', name: '认证创作者' } };
const XIAO = { handle: 'demo-marine', nickname: '陆战队员' };

const REPLIES: CommentData[] = [
  {
    id: 'r1',
    author: LIN,
    body: '这个思路对，但要注意前置依赖；<a href="' + appPath('u/58') + '" data-mention="58">@陆战队员</a> 上次直接覆盖 Maps 目录，结果旧存档读不出来。',
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
  {
    id: 'c3',
    author: LIN,
    body: [
      '<p>我把三章都通了一遍，按顺序说几个真会卡住人的地方：</p><p>① 第二章开头那波空投，如果你没提前把农民拉去分矿，正面是打不过的——AI 的第一波一定会打你主基地右侧的补给站，先把那里堵上。</p><p>② 中期那台雷神别急着拉出去，它的价值在守家。我试过提前推进，结果后方被绕，防线一崩整局就没了。</p><p>③ 第三章的隐藏结局要在地图右上角那个废墟触发，必须在 15 分钟前到，不然事件不刷新。我第一次就是晚了四十秒，白打一遍。</p><p>④ 存档兼容性：装过第二章的直接进游戏就行，但如果中途改过 MOD 顺序，建议先备份 Maps 目录，我上次直接覆盖，旧存档读不出来，重打了两个小时。</p><p>⑤ 最后，18 张地图里我个人觉得最难的是第 11 张（虫族那关），菌毯铺得太快，建议带两个工程车随时补防空。</p><p>大概就这些，有卡住的可以问我。</p>',
    ].join('\n'),
    createdAt: '2026-09-29 21:04',
    likes: 236,
    dislikes: 3,
    liked: true,
  },
  {
    id: 'c4',
    author: XIAO,
    body: '三章都通了，最后一关的演出是真的好，就是 BGM 有点吵。',
    createdAt: '2026-09-29 22:11',
    likes: 8,
    dislikes: 0,
  },
];

const ME = { nickname: '示范管理员', avatar: A('miyin-portrait-320.webp') };

// @ 提及候选（真实实现来自 GET /api/v1/users/search?q=）
const CANDIDATES: MentionCandidate[] = [
  { id: '12', nickname: '示范管理员', handle: 'demo-admin', avatar: A('miyin-portrait-320.webp'), role: { key: 'admin', name: '管理员' } },
  { id: '37', nickname: '雷神', handle: 'demo-thor', avatar: A('miyin-chibi-160.webp'), role: { key: 'creator', name: '认证创作者' } },
  { id: '58', nickname: '陆战队员', handle: 'demo-marine' },
  { id: '91', nickname: '陆战队员（同名）', handle: 'demo-marine-2', duplicate: true },
];

const COMMENTS: CommentData[] = [
  {
    id: 'c1',
    author: XIAO,
    body: '？为什么不叫我，<a href="' + appPath('u/12') + '" data-mention="12">@示范管理员</a> 你说说看',
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
  {
    id: 'c3',
    author: LIN,
    body:
      '<p>我把三章都通了一遍，按顺序说几个真会卡住人的地方：</p>' +
      '<p>① 第二章开头那波空投，如果你没提前把农民拉去分矿，正面是打不过的——AI 的第一波一定会打你主基地右侧的补给站，先把那里堵上。</p>' +
      '<p>② 中期那台雷神别急着拉出去，它的价值在守家。我试过提前推进，结果后方被绕，防线一崩整局就没了。</p>' +
      '<p>③ 第三章的隐藏结局要在地图右上角那个废墟触发，必须在 15 分钟前到，不然事件不刷新。我第一次就是晚了四十秒，白打一遍。</p>' +
      '<p>④ 存档兼容性：装过第二章的直接进游戏就行，但如果中途改过 MOD 顺序，建议先备份 Maps 目录，我上次直接覆盖，旧存档读不出来，重打了两个小时。</p>' +
      '<p>⑤ 最后，18 张地图里我个人觉得最难的是第 11 张（虫族那关），菌毯铺得太快，建议带两个工程车随时补防空。</p>' +
      '<p>⑥ 补充一个坑：第四章的护送关，护送目标不能离你太远，超过两屏它就会自己往回走，很容易被路上的巡逻队吃掉。我是用两个运输机跟着才过的。</p>' +
      '<p>⑦ 单位配比上，我最后是 6 工程车 / 12 陆战 / 4 坦克 / 2 雷神，防空靠两个工程车临时补。如果你的操作更细，可以把坦克换成女妖，机动性好很多。</p>' +
      '<p>⑧ 资源点记得提前开，尤其是左下的那个高能瓦斯，第三章之后 AI 会来抢。我第二次打就是晚开了两分钟，中期直接卡科技。</p>' +
      '<p>⑨ 大概就这些，有卡住的可以问我。</p>',
    createdAt: '2026-09-29 21:04',
    likes: 236,
    dislikes: 3,
    liked: true,
  },
  {
    id: 'c4',
    author: XIAO,
    body: '<p>三章都通了，最后一关的演出是真的好，就是 BGM 有点吵。</p>',
    createdAt: '2026-09-29 22:11',
    likes: 8,
    dislikes: 0,
  },
];

export default function CommentsPage() {
  // 赞踩必须有状态：**只传 comments 不传 onVote 时，按钮上只有数字、点了没反应**。
  // 这个包装件就是那条检查——点了要看到数字变、active 态跟着翻。
  const [comments, setComments] = useState<CommentData[]>(COMMENTS);
  function vote(id: string, value: 1 | -1) {
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
  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='评论区（整块 · CommentList）'
        note='对照 B 站：表头「评论 N」+ 最热｜最新，下面常驻评论框；主楼 15px、楼中楼 13px（层级靠字号/头像/间距，不靠竖线）。超长评论按渲染高度折叠（渐隐 + 展开），第三条就是用来验这条路径的。赞踩传了 onVote，点了要有反应（同向再点=取消）。'
      >
        <CommentList comments={comments} total={54} me={ME} candidates={CANDIDATES} onVote={vote} />
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
        <Row label='ReplyBox（回复框）' hint='原生 textarea（Ring 的 Input 是表单小输入，装不下长评论）：默认 7 行、随输入长高；只有一个发布按钮，空内容不可点'>
          <div className='w-full max-w-xl'>
            <ReplyBox me={ME} replyingTo='陆战队员' candidates={CANDIDATES} />
          </div>
        </Row>
      </Card>

      <Card name='待补' note='只列需求文档里确实有的（表情/回复配图不在需求里，已删掉）。'>
        <Row label='未做' hint='不做出来不许进业务页面；@ 提及已完成，从这里划掉'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>举报菜单</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>分页/加载更多</span>
        </Row>
      </Card>
    </div>
  );
}