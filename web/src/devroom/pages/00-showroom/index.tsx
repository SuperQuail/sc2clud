import Button from '@jetbrains/ring-ui-built/components/button/button';
import Code from '@jetbrains/ring-ui-built/components/code/code';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import { useState } from 'react';
import { Bookmark, MessageSquare, Share2, ThumbsUp } from 'lucide-react';
import { appPath, assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { UserAvatar } from '@/ui/user/avatar';
import { CommentBody } from '@/ui/comment/comment-body';
import { ReplyBox } from '@/ui/comment/reply-box';

// DevRoom 00 · 样板间：**帖子详情页**（不是社区主页——那个要专门设计）
// 内容型页面的好坏几乎全在排版，而排版有一组公认硬数值（引自公开的内容站设计规范）：
//   · 行宽 max-width: 65ch（50–75 字符，66 最优）——太宽眼睛找不到下一行开头
//   · 正文 18px、行高 1.6（移动端 1.4）；标题行高 1.15，大标题 1.0 且字距 -0.02em
//   · 字号 1.333 音阶（18 / 24 / 32 / 42）
//   · 目录放**左侧**并高亮当前小节；正文列里的目录不要吸顶
//   · 显示预计阅读时长（265 字/分钟）；内容页少用动效
// 这些数值就是后续页面的美术风格基准。
const BODY = [
  '<h2 id="s1">这一版改了什么</h2>',
  '<p>第三章的核心是把节奏收紧：前两章平均每关 18 分钟，这一章压到 12 分钟以内。相应地资源采集速度提高 15%，但敌军第一波也提前约 40 秒。</p>',
  '<ul><li>18 张新地图，其中 4 张为可跳过支线</li><li>三个结局，取决于第 11 关是否在 15 分钟内完成</li><li>存档兼容：装过第二章的直接进游戏，不用新开档</li></ul>',
  '<h3 id="s1-1">关于菌毯</h3>',
  '<p>第 11 关的菌毯推进比原版快一档，如果不在 8 分钟前补两个导弹塔，中期空中单位会直接穿过防线。实测带两个工程车随时修补最稳。</p>',
  '<blockquote><p>如果你在前面没升级防空，中期会很难受——这条来自 42 位通关玩家的共同反馈。</p></blockquote>',
  '<h2 id="s2">怎么安装</h2>',
  '<p>解压后把 Maps 目录放进游戏根目录，覆盖前先备份。</p>',
  '<h2 id="s3">已知问题</h2>',
  '<p>第 7 关在极少数机器上会出现贴图闪烁，临时解法是把画质从「极高」降到「高」。这个问题会在 3.1 修掉。</p>',
].join('');

const TOC = [
  { id: 's1', text: '这一版改了什么' },
  { id: 's1-1', text: '关于菌毯', sub: true },
  { id: 's2', text: '怎么安装' },
  { id: 's3', text: '已知问题' },
];

/** 预计阅读时长：规范给的基线 265 字/分钟 */
function readMinutes(html: string): number {
  return Math.max(1, Math.round(html.replace(/<[^>]+>/g, '').length / 265));
}

export default function ShowroomPage() {
  const [liked, setLiked] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const minutes = readMinutes(BODY);

  return (
    <div className='flex flex-col gap-6'>
      <h1 className='sr-only'>第三章「余烬」发布公告</h1>

      <div className='flex items-center'>
        <Breadcrumbs>
          <a href={appPath('')}>首页</a>
          <a href={appPath('b/campaign')}>自制战役</a>
          <span>第三章「余烬」发布公告</span>
        </Breadcrumbs>
      </div>

      <div className='grid gap-8 lg:grid-cols-[10rem_minmax(0,1fr)_15rem]'>
        {/* 左：目录（规范：放左侧、可吸顶；正文列内的目录不可吸顶） */}
        <nav aria-label='目录' className='hidden lg:block'>
          <div className='sticky top-6 flex flex-col gap-2 border-l border-border pl-3'>
            <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>目录</span>
            {TOC.map((t) => (
              <a
                key={t.id}
                href={'#' + t.id}
                className={
                  'rounded-[3px] text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 ' +
                  (t.sub ? 'pl-3' : '')
                }
              >
                {t.text}
              </a>
            ))}
          </div>
        </nav>

        {/* 正文列自己限宽：40rem ≈ 640px，中文约 35 字/行（中文最优行宽比拉丁文窄） */}
        <article className='flex min-w-0 max-w-[40rem] flex-col gap-5'>
          <header className='flex flex-col gap-3'>
            <span className='flex flex-wrap items-center gap-2'>
              <Tag tagType={TagType.MAIN}>公告</Tag>
              <Tag>第三章</Tag>
            </span>
            <h2 className='text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-foreground'>
              第三章「余烬」发布公告与更新日志
            </h2>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
              <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='md' />
              <span className='flex flex-col'>
                <span className='flex items-center gap-2'>
                  <Username nickname='唐天' strong />
                  <RoleBadge role={{ key: 'admin', name: '管理员' }} />
                  <TitleBadge title={{ name: '执政官', color: '#2563eb' }} size='sm' />
                </span>
                <span className='text-[13px] text-muted-foreground'>2026-09-28 09:10 · 预计阅读 {minutes} 分钟</span>
              </span>
            </div>
          </header>

          <CommentBody
            className='flex max-w-none flex-col gap-4 text-[18px] leading-[1.6] text-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_h2]:scroll-mt-24 [&_h2]:text-[24px] [&_h2]:leading-[1.15] [&_h2]:font-semibold [&_h3]:scroll-mt-24 [&_h3]:text-[20px] [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc'
            body={BODY}
          />

          <Code language='bash' code={'tar -xzf chapter3.tar.gz -C "$SC2_HOME"\ncp -r Maps "$SC2_HOME/Maps"'} />

          <img src={assetUrl('starcraft/sc2-battle.webp')} alt='第三章战场场景' className='w-full rounded-lg border border-border' />

          <div className='flex flex-wrap items-center gap-2 border-t border-border pt-4'>
            <Button primary={liked} icon={icon16(ThumbsUp)} onClick={() => setLiked((v) => !v)}>
              {liked ? '已赞' : '点赞'} 248
            </Button>
            <Button icon={icon16(Bookmark)}>收藏</Button>
            <Button icon={icon16(Share2)}>分享</Button>
            <Button icon={icon16(MessageSquare)} onClick={() => setReplyOpen((v) => !v)}>回复 64</Button>
          </div>

          {replyOpen ? (
            <ReplyBox
              me={{ nickname: '唐天', avatar: assetUrl('miyin-portrait-320.webp') }}
              onSubmit={() => setReplyOpen(false)}
            />
          ) : null}

          <section className='flex flex-col gap-5 border-t border-border pt-5'>
            <h3 className='text-[20px] leading-[1.2] font-semibold text-foreground'>回复 64</h3>
            <div className='flex gap-3'>
              <UserAvatar name='林诗' src={assetUrl('miyin-chibi-160.webp')} size='md' />
              <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
                <span className='flex flex-wrap items-center gap-2'>
                  <Username nickname='林诗' strong />
                  <RoleBadge role={{ key: 'creator', name: '认证创作者' }} />
                  <TitleBadge title={{ name: '精华作者', color: '#7c3aed' }} size='sm' />
                  <span className='text-[13px] text-muted-foreground'>2 小时前</span>
                </span>
                <CommentBody
                  collapsible
                  collapsedHeight={110}
                  className='text-[15px] leading-[1.7] text-foreground'
                  body={
                    '<p>第 11 关我打了三遍，最后是靠两个工程车贴着菌毯边缘补防空过去的。另外 ' +
                    '<a href="' + appPath('u/58') + '" data-mention="58">@某小X</a>' +
                    ' 说的分矿时机是对的，8 分钟前必须把左下的高能瓦斯开出来。</p>' +
                    '<p>补充一个坑：第 12 关开头如果防空不满，运输机会直接被点掉，建议留一队守家。</p>' +
                    '<p>还有一个细节——护送的 NPC 不能离你超过两屏，否则它会自己往回走，很容易被路上的巡逻队吃掉。</p>'
                  }
                />
                <div className='mt-2 flex flex-col gap-3 border-l-2 border-border pl-3'>
                  <div className='flex gap-2.5'>
                    <UserAvatar name='某小X' size='sm' />
                    <div className='flex flex-col gap-1'>
                      <span className='flex items-center gap-2'>
                        <Username nickname='某小X' size='sm' />
                        <span className='text-[12px] text-muted-foreground'>1 小时前</span>
                      </span>
                      <CommentBody className='text-[13px] leading-[1.6] text-foreground' body='<p>对，左下那个瓦斯我上次晚开两分钟，中期直接卡科技。</p>' />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </article>

        <aside className='flex flex-col gap-3'>
          <Island withoutPaddings>
            <div className='flex flex-col gap-3 p-4'>
              <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>作者</span>
              <span className='flex items-center gap-3'>
                <UserAvatar name='唐天' src={assetUrl('miyin-portrait-320.webp')} size='lg' />
                <span className='flex flex-col gap-1'>
                  <Username nickname='唐天' size='lg' strong />
                  <span className='text-[12px] text-muted-foreground'>@tangtian</span>
                </span>
              </span>
              <span className='text-[13px] leading-relaxed text-muted-foreground'>
                战役作者，负责关卡设计与剧情。有问题直接在这里回复，我每天都在。
              </span>
              <Button primary>关注作者</Button>
            </div>
          </Island>

          <Island withoutPaddings>
            <div className='flex flex-col gap-2.5 p-4'>
              <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>相关主题</span>
              {[
                { id: 11, t: '第 11 关图文攻略（含路线图）' },
                { id: 12, t: '存档兼容性与常见问题' },
                { id: 13, t: '第一章素材包下载' },
              ].map((r) => (
                <a
                  key={r.id}
                  href={appPath('t/' + r.id)}
                  className='rounded-[3px] text-[13px] leading-snug text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
                >
                  {r.t}
                </a>
              ))}
            </div>
          </Island>
        </aside>
      </div>
    </div>
  );
}
