// 下载来源岛：先把服务端渲染好的行读成初值，再交给 React 接管（无 JS 时原样可用）
import { createRoot } from 'react-dom/client'
import { Sources, type SourceProvider, type SourceSlot } from '../../ui/Sources'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="sources"]').forEach((host) => {
  const initial: SourceSlot[] = []
  host.querySelectorAll<HTMLElement>('.source-row').forEach((row) => {
    const pick = <T extends HTMLElement>(selector: string) => row.querySelector<T>(selector)
    initial.push({
      provider: pick<HTMLSelectElement>('select[name=provider]')?.value ?? '',
      label: pick<HTMLInputElement>('input[name=label]')?.value ?? '',
      code: pick<HTMLInputElement>('input[name=code]')?.value ?? '',
      url: pick<HTMLInputElement>('input[name=url]')?.value ?? '',
    })
  })
  const providers: SourceProvider[] = Array.from(
    host.querySelectorAll<HTMLOptionElement>('select[name=provider] option'),
  ).map((option) => ({ value: option.value, label: option.textContent ?? option.value }))
  const unique = providers.filter((p, i) => providers.findIndex((x) => x.value === p.value) === i)
  createRoot(host).render(<Sources providers={unique.length > 0 ? unique : [{ value: 'other', label: '其它' }]} initial={initial} />)
})
