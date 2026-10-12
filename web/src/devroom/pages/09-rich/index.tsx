import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Card, Row } from '@/devroom/kit';
import { CommentBody } from '@/ui/comment/comment-body';
import { plainLength } from '@/ui/rich/markdown';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';

// DevRoom 09 · 富文本编辑器与图片上传（两个高复用控件）
// 图片能力全部由属性控制：max（默认 10）、compress（默认开）、allowOriginal（默认关）。
const CANDIDATES = [
  { id: '12', nickname: '唐天', handle: 'tangtian', role: { key: 'admin', name: '管理员' } },
  { id: '37', nickname: '林诗', handle: 'linshi', role: { key: 'creator', name: '认证创作者' } },
  { id: '58', nickname: '某小X', handle: 'xiaox' },
  { id: '91', nickname: '唐天（同名）', handle: 'tangtian2', duplicate: true },
];

export default function RichPage() {
  const [imgs10, setImgs10] = useState<UploadedImage[]>([]);
  const [imgs3, setImgs3] = useState<UploadedImage[]>([]);
  const [row, setRow] = useState<{ id: string; body_md: string; saved_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 模拟后端：**只存 content_md**（Markdown 原文），不存 HTML —— 与后端 §9 契约一致 */
  function save() {
    setBusy(true);
    window.setTimeout(() => {
      setRow({ id: 'p_' + Math.random().toString(36).slice(2, 8), body_md: md, saved_at: new Date().toLocaleTimeString() });
      setBusy(false);
    }, 250);
  }
  const [md, setMd] = useState('');
  const [imgs, setImgs] = useState<UploadedImage[]>([]);

  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='富文本编辑器（帖子正文用）'
        note='**底层是 Markdown**（后端 content_md 就是它）；左边写源码、右边实时预览，预览由 marked 解析 + DOMPurify 清洗；工具栏是 Ring Button，图片走上传控件。'
      >
        <MarkdownEditor
          value={md}
          candidates={CANDIDATES}
          onChange={setMd}
          images={imgs}
          onImagesChange={setImgs}
          maxImages={10}
          allowOriginal
        />
        <Row label='当前内容' hint='正文存 Markdown（后端 content_md），HTML 由服务端 goldmark 渲染并清洗'>
          <span className='text-[12px] text-muted-foreground'>
            正文 {plainLength(md)} 字　图片 {imgs.length} 张　（底层是 Markdown，HTML 只在预览时现算）
          </span>
        </Row>
      </Card>

      <Card
        name='往返测试：存一次，再读回来'
        note='存：只存 Markdown 原文（模拟后端 content_md）。读：用**只读渲染器**渲染回来——与评论区共用同一个 markdown.ts，所以预览与最终展示必然一致。'
      >
        <Row label='① 存' hint='把当前 Markdown 存进模拟的那一行；@提及会以 token 形式存下去'>
          <Button primary disabled={md.trim().length === 0 || busy} onClick={save}>
            {busy ? '保存中…' : '存一次（模拟发布）'}
          </Button>
          <span className='text-[11px] text-muted-foreground'>{plainLength(md)} 字 / {imgs.length} 张图</span>
        </Row>
        {row ? (
          <>
            <Row label='② 存储里到底存了什么' hint='就是后端那行的 content_md，原样：'>
              <pre className='max-h-40 w-full overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[12px] whitespace-pre-wrap text-foreground'>
                {JSON.stringify(row, null, 2)}
              </pre>
            </Row>
            <Row label='③ 读回来' hint='和上面的 token 对照：@{12|唐天} 应该渲染成可点的 @唐天'>
              <div className='w-full max-w-2xl rounded-md border border-border p-3'>
                <CommentBody body={row.body_md} className='prose prose-sm max-w-none text-foreground' />
              </div>
            </Row>
          </>
        ) : (
          <Row label='② ③' hint='还没存过'>
            <span className='text-[12px] text-muted-foreground'>上面写点东西（试试 @ 提及 + 一张图），再点「存一次」。</span>
          </Row>
        )}
      </Card>
      <Card
        name='图片上传控件 · 允许原图（max=10）'
        note='默认自动压缩：长边 1600、WebP 0.82。打开「上传原图」后本次选择跳过压缩，缩略图上会标出「原图/压缩」与实际体积。'
      >
        <Row label='上传 / 删除 / 超限提示' hint='超过上限的会提示并忽略'>
          <ImageUploader images={imgs10} onChange={setImgs10} max={10} allowOriginal compress />
        </Row>
      </Card>

      <Card
        name='图片上传控件 · 禁止原图 + 上限 3'
        note='allowOriginal=false 时界面上**不会出现**「上传原图」开关——能力由使用方决定，控件不自己决定。'
      >
        <Row label='只能压缩上传'>
          <ImageUploader images={imgs3} onChange={setImgs3} max={3} allowOriginal={false} compress />
        </Row>
      </Card>

      <Card name='待补' note='按需求文档只列确实要做的。'>
        <Row label='未做' hint='不做出来不许进业务页面'>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>图片拖拽排序</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>粘贴上传</span>
          <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>上传进度与失败重试</span>
        </Row>
      </Card>
    </div>
  );
}
