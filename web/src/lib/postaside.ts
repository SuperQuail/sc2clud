// 帖子页右栏数据层：剪贴板 / 镜像实测（AGENTS §6.6：fetch 只住在 lib/）

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

/** HEAD 探一下镜像耗时。no-cors 读不到状态码，只量到「有响应」为止。 */
function probeMirror(url: string): Promise<number> {
  const started = performance.now()
  return fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' })
    .catch(() => undefined)
    .then(() => performance.now() - started)
}

/** 实测各镜像延迟，最快的排到最前并选中（原链恒留第一项）。 */
export async function rankMirrors(root: HTMLElement): Promise<{ label: string; ms: number } | null> {
  const select = root.querySelector<HTMLSelectElement>('[data-mirror-select]')!
  const options = [...select.options]
  const probes = options.filter((option) => option.dataset.mirrorOriginal === 'false')
  if (probes.length === 0) return null
  const ranked = (await Promise.all(probes.map(async (option) => [option, await probeMirror(option.value)] as const)))
    .sort((a, b) => a[1] - b[1])
  for (const option of probes) option.textContent = option.textContent?.replace(/（最快.*）$/, '') ?? ''
  const fastest = ranked[0][0]
  // 原链保持第一项，其余按实测耗时重排；最快的那条标注出来并选中
  select.replaceChildren(...options.filter((o) => o.dataset.mirrorOriginal === 'true'), ...ranked.map(([option]) => option))
  fastest.textContent = `${fastest.textContent}（最快）`
  select.value = fastest.value
  return { label: fastest.textContent, ms: ranked[0][1] }
}
