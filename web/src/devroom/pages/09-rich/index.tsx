import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Card, Row } from '@/devroom/kit';
import { CommentBody } from '@/ui/comment/comment-body';
import { textLength } from '@/ui/comment/comment-body';
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
  const [row, setRow] = useState<{ id: string; content_json: string; content_html: string; saved_at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 模拟后端：存 Lexical 的 **EditorState JSON**（真源）+ 写入时生成的 HTML（只读展示用） */
  function save() {
    setBusy(true);
    window.setTimeout(() => {
      setRow({ id: 'p_' + Math.random().toString(36).slice(2, 8), content_json: doc.json, content_html: doc.html, saved_at: new Date().toLocaleTimeString() });
      setBusy(false);
    }, 250);
  }
  const [doc, setDoc] = useState<{ json: string; html: string }>({ json: '', html: '' });
  const [imgs, setImgs] = useState<UploadedImage[]>([]);

  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='富文本编辑器（帖子正文用）'
        note='**所见即所得**（Lexical 内核）。存储用它 **EditorState JSON**（节点自带 type/version，无损往返），写入时同时生成 HTML 供只读展示；工具栏与输入 @ 走同一个候选面板；图片是正文节点。'
      >
        <MarkdownEditor
          value={doc.json}
          candidates={CANDIDATES}
          onChange={(json, html) => setDoc({ json, html })}
          images={imgs}
          onImagesChange={setImgs}
          maxImages={10}
          allowOriginal
        />
        <Row label='当前内容' hint='正文存 EditorState JSON（后端 content_json），HTML 由前端生成、服务端清洗后存 content_html'>
          <span className='text-[12px] text-muted-foreground'>
            正文 {textLength(doc.html)} 字　图片 {imgs.length} 张　（真源：EditorState JSON；HTML 是派生物）
          </span>
        </Row>
      </Card>

      <Card
        name='往返测试：存一次，再读回来'
        note='存：JSON + HTML（模拟后端的 content_json / content_html）。读：直接用存下来的 HTML 渲染回来——与评论区共用同一个 CommentBody。'
      >
        <Row label='① 存' hint='把当前的 JSON + HTML 存进模拟的那一行'>
          <Button primary disabled={textLength(doc.html) === 0 || busy} onClick={save}>
            {busy ? '保存中…' : '存一次（模拟发布）'}
          </Button>
          <span className='text-[11px] text-muted-foreground'>{textLength(doc.html)} 字 / {imgs.length} 张图</span>
        </Row>
        {row ? (
          <>
            <Row label='② 存储里到底存了什么' hint='后端那两列的样子（JSON 太长，这里截断显示）：'>
              <pre className='max-h-40 w-full overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[12px] whitespace-pre-wrap text-foreground'>
                {JSON.stringify({ ...row, content_json: row.content_json.slice(0, 160) + (row.content_json.length > 160 ? '…' : '') }, null, 2)}
              </pre>
            </Row>
            <Row label='③ 读回来' hint='读回来的样子——提及是链接、图片是图片'>
              <div className='w-full max-w-2xl rounded-md border border-border p-3'>
                <CommentBody body={row.content_html} className='prose prose-sm max-w-none text-foreground' />
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
