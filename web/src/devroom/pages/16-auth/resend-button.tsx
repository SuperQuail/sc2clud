import Button from '@jetbrains/ring-ui-built/components/button/button';

// 「重新发送验证码」：后端限流 1 分钟 1 次，所以按钮自己带冷却，不等服务端再拒一次。
// 重发的语义是「作废旧的、发新的」——文案里要写清旧码会失效（§11.2）。
export type ResendButtonProps = {
  /** 剩余秒数（>0 时按钮禁用并显示倒计时） */
  seconds: number;
  busy?: boolean;
  onSend: () => void;
  label?: string;
};

export function ResendButton({ seconds, busy, onSend, label = '重新发送验证码' }: ResendButtonProps) {
  const blocked = seconds > 0;
  return (
    <Button
      inline={false}
      disabled={blocked || busy}
      loader={busy}
      onClick={onSend}
      aria-label={blocked ? label + '（' + seconds + ' 秒后可再发）' : label}
    >
      {blocked ? label + '（' + seconds + ' s）' : label}
    </Button>
  );
}
