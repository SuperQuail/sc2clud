import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { RotateCcw } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { Panel, Pill } from '../bits';
import { AI_BUILTIN_PROMPTS, AI_SCENARIOS, promptSource, type AiConfig } from '../mock';

// 提示词编辑：**两套**（新建帖审核 / 举报复核，d7 §1 的两个入口）。
// 三条纪律：
//   ① 留空 = 用内置默认（d7 §4）—— 界面必须让人一眼看出「我现在用的是内置那套」还是「已被我覆盖」；
//   ② 内置默认**改不了**，只读展示 —— 它是代码里那份，改界面上的文本不会改它；
//   ③ 举报复核那套默认就是「新建帖那套 + 一句「已被 N 人举报」」，不是另写一条提示词（d7 §1）。
export function AiPrompts({ cfg, canEdit, onPatch }: {
  cfg: AiConfig;
  canEdit: boolean;
  onPatch: (next: Partial<AiConfig>) => void;
}) {
  return (
    <div className='grid items-start gap-3 lg:grid-cols-2'>
      {AI_SCENARIOS.map((s) => {
        const custom = s.key === 'create' ? cfg.prompt : cfg.prompt_report;
        const source = promptSource(cfg, s.key);
        return (
          <Panel
            key={s.key}
            title={s.label}
            note={s.editorHint}
            actions={
              <>
                <Pill tone='outline'>{s.trigger}</Pill>
                <Pill tone={source === 'custom' ? 'warn' : 'ok'}>{source === 'custom' ? '自定义覆盖' : '内置默认'}</Pill>
              </>
            }
          >
            <Input
              label='提示词（留空 = 用下面的内置默认）'
              multiline
              rows={9}
              // Ring 的 textarea 高度由它自己的 CSS 决定，rows 不生效 → 显式给高度（与旧屏一致）
              inputClassName='!h-[196px]'
              data-testid={'ai-prompt-' + s.key}
              value={custom}
              disabled={!canEdit}
              onChange={(e) => onPatch(s.key === 'create' ? { prompt: e.target.value } : { prompt_report: e.target.value })}
            />
            <div className='mt-1 flex flex-wrap items-center gap-2'>
              <Button
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(RotateCcw)}
                disabled={!canEdit || source === 'builtin'}
                onClick={() => onPatch(s.key === 'create' ? { prompt: '' } : { prompt_report: '' })}
              >
                清空自定义，回到内置默认
              </Button>
              {source === 'builtin' ? <span className='text-[11px] text-muted-foreground'>当前生效的就是下面这段（代码里的那份，界面上改不到它）</span> : null}
            </div>
            <div className='mt-2 rounded-md bg-muted/50 px-2 py-1.5'>
              <span className='text-[11px] font-medium text-muted-foreground'>内置默认提示词（只读）</span>
              <p className='mt-1 max-h-[140px] overflow-auto whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground'>
                {AI_BUILTIN_PROMPTS[s.key]}
              </p>
              {s.key === 'report' ? (
                <p className='mt-1 text-[11px] leading-relaxed text-muted-foreground'>
                  上面那句里的 <code className='rounded-sm bg-muted px-1'>N</code> 由任务在运行时换成真实举报数（试跑面板里能看见换完的样子）。
                </p>
              ) : null}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
