import { useState } from 'react';
import { Card, Row } from '@/devroom/kit';
import { plainLength } from '@/ui/rich/markdown';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';

// DevRoom 09 · 富文本编辑器与图片上传（两个高复用控件）
// 图片能力全部由属性控制：max（默认 10）、compress（默认开）、allowOriginal（默认关）。
export default function RichPage() {
  const [imgs10, setImgs10] = useState<UploadedImage[]>([]);
  const [imgs3, setImgs3] = useState<UploadedImage[]>([]);
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
