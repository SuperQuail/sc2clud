// 帖子页右栏行为：剪贴板 / 镜像实测（AGENTS §6.6：fetch 只住在 lib/）
// 这块不需要 React：服务端已经把下拉、按钮、提示都渲染好了，这里只接行为。

/**
 * 复制文本。navigator.clipboard 只在安全上下文（https / localhost）可用，
 * 本站目前是纯 http，所以必须留 execCommand 兜底，否则按钮点了没反应。
 */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(area)
    if (ok) resolve()
    else reject(new Error('execCommand 复制失败'))
  })
}

/** 复制按钮的反馈：成功回显「已复制 ✓」；两条路都失败就弹出来手动复制。 */
export async function copyWithFeedback(button: HTMLButtonElement, text: string) {
  const label = button.textContent
  try {
    await copyText(text)
    button.textContent = '已复制 ✓'
  } catch {
    button.textContent = '复制失败，请手动复制'
    window.prompt('自动复制不可用，请按 Ctrl+C 复制：', text)
  }
  window.setTimeout(() => { button.textContent = label }, 2000)
}

/** 镜像没响应时的上限：外站可能一直挂着（HEAD 不返回也不报错），超了就当没响应。 */
const PROBE_TIMEOUT_MS = 4000

/** HEAD 探一下镜像耗时。no-cors 读不到状态码，只量到「有响应」为止；超时返回 null。 */
function probeMirror(url: string): Promise<number | null> {
  const started = performance.now()
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  return fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: abort.signal })
    .then(() => performance.now() - started)
    .catch(() => null)
    .finally(() => window.clearTimeout(timer))
}

/**
 * 实测各镜像延迟，最快的排到最前并选中（原链恒留第一项）。
 * 全都没响应时返回 { ms: null }，由调用方换一句实话。
 */
export async function rankMirrors(root: HTMLElement): Promise<{ label: string; ms: number | null } | null> {
  const select = root.querySelector<HTMLSelectElement>('[data-mirror-select]')!
  const options = [...select.options]
  const probes = options.filter((option) => option.dataset.mirrorOriginal === 'false')
  if (probes.length === 0) return null
  const ranked = (await Promise.all(probes.map(async (option) => [option, await probeMirror(option.value)] as const)))
    .sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity))
  for (const option of probes) option.textContent = option.textContent?.replace(/（最快.*）$/, '') ?? ''
  const [fastest, ms] = ranked[0]
  // 原链保持第一项，其余按实测耗时重排；最快的那条标注出来并选中
  select.replaceChildren(...options.filter((o) => o.dataset.mirrorOriginal === 'true'), ...ranked.map(([option]) => option))
  fastest.textContent = `${fastest.textContent}（最快）`
  select.value = fastest.value
  return { label: fastest.textContent, ms }
}

/**
 * 接上右栏资源区的行为：复制原链 + 镜像测速。
 * 由 islands/postaside/main.ts 在页面加载时直接调用——没有挂载点，
 * 因为空的挂载点会在 .post-layout 里多占一个网格位，把右栏挤到下一行。
 */
export function bindPostAside(root: ParentNode = document) {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-github]')) {
    button.addEventListener('click', () => void copyWithFeedback(button, button.dataset.copyGithub ?? ''))
  }
  for (const box of root.querySelectorAll<HTMLElement>('[data-mirror-box]')) {
    const select = box.querySelector<HTMLSelectElement>('[data-mirror-select]')
    const open = box.querySelector<HTMLButtonElement>('[data-mirror-open]')
    const note = box.querySelector<HTMLElement>('[data-mirror-note]')
    if (!select || !open) continue
    open.addEventListener('click', () => window.open(select.value, '_blank', 'noopener,noreferrer'))
    void rankMirrors(box).then((fastest) => {
      if (!note) return
      if (!fastest) note.textContent = '只有一个原链来源；网络慢的话可以自己挂代理'
      else if (fastest.ms === null) note.textContent = '镜像都没响应（超时），先用原链或自己挂代理'
      else note.textContent = `已实测：最快的是 ${fastest.label.replace('（最快）', '')}（约 ${Math.round(fastest.ms)} ms）`
    })
  }
}
