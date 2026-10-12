import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import AvatarStack from '@jetbrains/ring-ui-built/components/avatar-stack/avatar-stack';
import Code from '@jetbrains/ring-ui-built/components/code/code';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { Card, Row } from '@/devroom/kit';

// DevRoom 04 · 展示与状态（README 规划的第四页）
// 只读展示类：颜色、尺寸、长文本是重点；这一类不会因为交互出错而暴露问题，所以更要逐个渲染出来看。
export default function DisplayPage() {
  return (
    <div className='flex flex-col gap-4'>
      <Card name='标签 Tag' note='六种预设色由 tagType 给；自定义色传 backgroundColor/textColor（半透明色自己 color-mix）。'>
        <Row label='预设色 / 自定义 / 描边'>
          <Tag tagType={TagType.MAIN}>主色</Tag>
          <Tag tagType={TagType.SUCCESS}>已通过</Tag>
          <Tag tagType={TagType.WARNING}>待审核</Tag>
          <Tag tagType={TagType.ERROR}>已拒绝</Tag>
          <Tag tagType={TagType.PURPLE}>精华</Tag>
          <Tag backgroundColor='color-mix(in srgb, #dc2626 14%, transparent)' textColor='#dc2626'>自定义</Tag>
          <Tag outline>描边</Tag>
        </Row>
      </Card>

      <Card name='头像 Avatar / AvatarStack' note='⚠️ **Ring 的 Avatar 是给「项目 / 组织」用的色块首字，不是用户头像**——用户头像一律用我们的 UserAvatar（按昵称取稳定色、有图用图）。这里只做对照，业务页面不要用它渲染用户。'>
        <Row label='尺寸 / 圆形 / 无图兜底 / 叠加'>
          <Avatar size={24} username='唐天' />
          <Avatar size={32} round username='林诗' />
          <Avatar size={40} username='某小X' />
          <AvatarStack size={32}>
            <Avatar size={32} username='唐天' />
            <Avatar size={32} username='林诗' />
            <Avatar size={32} username='某小X' />
          </AvatarStack>
        </Row>
      </Card>

      <Card name='进度 ProgressBar' note='上限与当前值；**不要自己拼一个 div 宽度当进度条**（无障碍上它是 progressbar 角色）。'>
        <Row label='常规 / 满值 / 静态色'>
          <div className='w-64'><ProgressBar value={30} max={100} /></div>
          <div className='w-64'><ProgressBar value={100} max={100} staticColor /></div>
        </Row>
      </Card>

      <Card name='代码 Code' note='行内与块级；行内用于正文里的 `函数名`，块级用于配置片段。'>
        <Row label='行内 / 块级 / 换行'>
          <span className='text-[13px] text-foreground'>用法：<Code inline code='forum import-users' /></span>
          <div className='w-full max-w-lg'>
            <Code
              language='bash'
              code={'forum serve -addr 127.0.0.1:8080\nforum import-users --from old.sqlite3'}
            />
          </div>
        </Row>
      </Card>

      <Card name='待补' note='展示类的空态/骨架还没做。'>
        <Row label='未做' hint='不做出来不许进业务页面'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>骨架屏 Skeleton（Ring 无此件，需自建或另找）</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>空态块（暂无内容 + 主操作）</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>Markdown 只读渲染（我们用 Lexical HTML，不需要 Ring 的 Markdown）</span>
        </Row>
      </Card>
    </div>
  );
}
