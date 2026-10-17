import Button from '@jetbrains/ring-ui-built/components/button/button';
import Radio from '@jetbrains/ring-ui-built/components/radio/radio';
import Tag from '@jetbrains/ring-ui-built/components/tag/tag';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Plus } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 设置面板。**按行描述（模式驱动）**：调用方给一组 rows，组件只负责排版。
// 三种行：radio（单选一组）/ toggle（开或关）/ tags（可增删的字符串列表）。
// 控件全部用 Ring（Radio / Toggle / Button），不自建。
export type SettingRow =
  | {
      key: string;
      kind: 'radio';
      title: string;
      hint?: string;
      options: Array<{ key: string; label: string }>;
      value: string;
      onChange: (value: string) => void;
    }
  | {
      key: string;
      kind: 'toggle';
      title: string;
      hint?: string;
      value: boolean;
      onChange: (value: boolean) => void;
    }
  | {
      key: string;
      kind: 'tags';
      title: string;
      hint?: string;
      items: string[];
      addLabel?: string;
      onAdd?: () => void;
      onRemove?: (item: string) => void;
    };

export function NoticeSettings({ rows }: { rows: SettingRow[] }) {
  return (
    <div data-testid='notice-settings' className='flex flex-col gap-4'>
      {rows.map((row) => (
        <section key={row.key} className='flex flex-col gap-3 rounded-lg border border-border bg-background px-4 py-4'>
          <span className='flex flex-wrap items-baseline gap-2'>
            <h3 className='text-[15px] font-medium text-foreground'>{row.title}</h3>
            {row.hint ? <span className='text-[13px] text-muted-foreground'>{row.hint}</span> : null}
          </span>
          {row.kind === 'radio' ? (
            <span className='flex flex-wrap items-center gap-x-6 gap-y-2'>
              {row.options.map((o) => (
                // 必须用 Radio.Item：Radio 本身不渲染 DOM（写成 <Radio>标签</Radio> 会得到一行不可点的纯文字，
                // 而且 typecheck 不报 —— 见 registry.ts 的 radio 条目）
                <Radio.Item
                  key={o.key}
                  name={row.key}
                  value={o.key}
                  checked={row.value === o.key}
                  onChange={() => row.onChange(o.key)}
                >
                  {o.label}
                </Radio.Item>
              ))}
            </span>
          ) : null}
          {row.kind === 'toggle' ? (
            <Toggle checked={row.value} onChange={(e) => row.onChange(e.target.checked)}>
              {row.value ? '开启' : '关闭'}
            </Toggle>
          ) : null}
          {row.kind === 'tags' ? (
            <span className='flex flex-wrap items-center gap-2'>
              {row.items.map((t) => (
                <span key={t} className='inline-flex items-center'>
                  <Tag onRemove={row.onRemove ? () => row.onRemove?.(t) : undefined}>{t}</Tag>
                </span>
              ))}
              {row.onAdd ? (
                <Button data-testid='setting-add' ghost icon={icon16(Plus)} onClick={row.onAdd}>
                  {row.addLabel ?? '添加'}
                </Button>
              ) : null}
            </span>
          ) : null}
        </section>
      ))}
    </div>
  );
}
