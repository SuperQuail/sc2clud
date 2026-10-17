import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Tooltip from '@jetbrains/ring-ui-built/components/tooltip/tooltip';
import ErrorMessage from '@jetbrains/ring-ui-built/components/error-message/error-message';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import { Card, Row } from '@/devroom/kit';

// DevRoom 02 · 浮层与反馈（按 README 的规划页）
// 这一页关心的是**焦点、键盘、层级、遮挡**——同一类控件放一起才看得出它们是否协调。
// 全部用 Ring UI 现成的控件，不自己写浮层。
export default function OverlayPage() {
  const [dialog, setDialog] = useState(false);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className='flex flex-col gap-4'>
      <Card
        name='对话框 Dialog'
        note='Ring UI 自带：遮罩点击、Esc、焦点陷阱（trapFocus）都由控件负责。不要自己写弹层——焦点与层级是最容易出错的部分。'
      >
        <Row label='常规 / 模态 / 带关闭按钮' hint='label 是无障碍标题，必填'>
          <Button onClick={() => setDialog(true)}>打开对话框</Button>
          <Button onClick={() => setModal(true)}>模态对话框</Button>
          <span className='text-[12px] text-muted-foreground'>正在打开：{dialog ? '常规' : modal ? '模态' : '无'}</span>
        </Row>
        <Row label='禁用 / 加载中' hint='按钮自身的状态，不是对话框的'>
          <Button disabled>不可用</Button>
          <Button loader={busy}>提交中</Button>
          <Button onClick={() => { setBusy(true); window.setTimeout(() => setBusy(false), 1500); }}>模拟提交</Button>
        </Row>
        {dialog ? (
          <Dialog
            show
            label='删除这条回复？'
            onCloseAttempt={() => setDialog(false)}
            onOverlayClick={() => setDialog(false)}
            onEscPress={() => setDialog(false)}
          >
            <div className='flex flex-col gap-3 p-4'>
              <p className='text-[13px] text-foreground'>删除后无法恢复，回复里的图片也会一起消失。</p>
              <div className='flex justify-end gap-2'>
                <Button onClick={() => setDialog(false)}>取消</Button>
                <Button danger onClick={() => setDialog(false)}>删除</Button>
              </div>
            </div>
          </Dialog>
        ) : null}
        {modal ? (
          <Dialog show modal label='举报这条回复' trapFocus onCloseAttempt={() => setModal(false)}>
            <div className='flex flex-col gap-3 p-4'>
              <p className='text-[13px] text-foreground'>模态：必须显式关闭才能继续操作。</p>
              <div className='flex justify-end'>
                <Button onClick={() => setModal(false)}>知道了</Button>
              </div>
            </div>
          </Dialog>
        ) : null}
      </Card>

      <Card name='提示 Tooltip' note='悬停/聚焦显示；延迟由控件管，避免鼠标划过时乱闪。'>
        <Row label='短提示 / 长提示 / 禁用'>
          <Tooltip title='置顶这个帖子'>
            <Button>置顶</Button>
          </Tooltip>
          <Tooltip long title='长提示用于需要解释清楚的场合：置顶后该帖子会一直排在分区列表最前面，直到你取消置顶或它被删除。'>
            <Button>置顶（长说明）</Button>
          </Tooltip>
          <Tooltip title='这一条不会显示' hide>
            <Button>不显示提示</Button>
          </Tooltip>
        </Row>
      </Card>

      <Card name='加载 LoaderInline' note='行内加载：用在按钮旁边、列表底部这类局部位置；整页加载才用 LoaderScreen。'>
        <Row label='默认 / 带说明'>
          <LoaderInline />
          <span className='flex items-center gap-2 text-[13px] text-muted-foreground'>
            <LoaderInline /> 正在加载评论…
          </span>
        </Row>
      </Card>

      <Card name='错误提示 ErrorMessage' note='页面级的错误：code + message + description 三段，比自己拼一段红字规范（而且自带无障碍结构）。'>
        <Row label='完整 / 只有消息 / 自定义图标'>
          <ErrorMessage
            code='403'
            message='你没有权限查看这个分区'
            description='该分区仅对认证创作者开放。如果你认为这是误判，可以联系管理员。'
          />
          <ErrorMessage message='加载失败，请稍后重试' />
        </Row>
      </Card>
    </div>
  );
}
