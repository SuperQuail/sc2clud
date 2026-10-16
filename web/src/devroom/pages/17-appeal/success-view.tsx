import Button from '@jetbrains/ring-ui-built/components/button/button';
import { AuthShell } from '@/devroom/pages/16-auth/auth-shell';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import type { AppealTypeConfig } from './data';

// 提交之后的结果态。**这一屏是本页存在的一半理由**：盲审二号报过「点完申诉，帖子提示区不变，
// 只有（真实页面没有的）演示条在动」——用户以为没点上，于是重复点。所以这里五样都要有：
// 单号（可抄走）+ 事由回显 + 多久答复 + 去哪看进展 + 「我们收下了」的承诺。
export type SuccessViewProps = {
  cfg: AppealTypeConfig;
  no: string;
  /** 提交时是否登录（未登录的那条路要提醒：单号是唯一凭据） */
  guest: boolean;
  /** 「再提交一条」：清空表单回到起点 */
  onAgain: () => void;
};

export function SuccessView({ cfg, no, guest, onAgain }: SuccessViewProps) {
  return (
    <AuthShell
      title='已收到，这是你的回执'
      subtitle={'事由：' + cfg.label}
      footer='这页是演示：单号与答复时间都是编的，真实现由后端发号。'
    >
      <FormAlert tone='success' title={cfg.done.promise} description={'单号 ' + no + '。把它抄下来，它就是查询这条申诉的凭据。'} />

      <div className='flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 text-[12px] leading-relaxed'>
        <Row k={cfg.done.unit} v={no} mono />
        <Row k='预计答复' v={cfg.done.eta} />
        <Row k='答复去哪看' v={cfg.done.follow} />
        {guest ? (
          <Row
            k='凭据'
            v='单号请存好。未登录时本页只留你这次提交的记录（刷新即散）—— 之后要按单号查进展，需要登录后再查。'
          />
        ) : null}
      </div>

      {!guest ? (
        <FormAlert
          tone='info'
          title='已发一条通知给你'
          description='处理这条申诉的人会在后台队列里看到它；答复时你会收到站内通知，本页「我的申诉」里同样能看到。'
        />
      ) : null}

      {/* 只留一颗：原来「再提交一条」与「回到表单」是同一个 onAgain，两颗按钮做同一件事 */}
      <div className='flex flex-wrap items-center gap-2'>
        <Button primary inline={false} onClick={onAgain}>
          再提交一条
        </Button>
      </div>
    </AuthShell>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className='flex items-start justify-between gap-3'>
      <span className='shrink-0 text-muted-foreground'>{k}</span>
      <span className={mono ? 'text-right font-mono font-medium text-foreground' : 'text-right text-foreground'}>{v}</span>
    </div>
  );
}
