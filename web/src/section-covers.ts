// 分区封面：本地预览与真实上传分开，失败时保留选图以便重试。
const grid = document.querySelector<HTMLElement>('[data-cover-csrf]')

grid?.querySelectorAll<HTMLElement>('[data-cover-card]').forEach((card) => {
  const input = card.querySelector<HTMLInputElement>('[data-cover-input]')!
  const image = card.querySelector<HTMLImageElement>('[data-cover-image]')!
  const badge = card.querySelector<HTMLElement>('[data-cover-badge]')!
  const note = card.querySelector<HTMLElement>('[data-cover-note]')!
  const save = card.querySelector<HTMLButtonElement>('[data-cover-save]')!
  const cancel = card.querySelector<HTMLButtonElement>('[data-cover-cancel]')!
  const picks = card.querySelectorAll<HTMLButtonElement>('[data-cover-pick]')
  let original = image.getAttribute('src') || ''
  let selected: File | null = null
  let preview = ''
  let revision = 0
  let busy = false
  let dragDepth = 0
  const urls = new Set<string>()

  function state(value: string, text: string) {
    card.dataset.state = value
    note.textContent = text
    note.hidden = value === 'idle'
    badge.hidden = value === 'idle'
    badge.textContent = { idle: original ? '已设置' : '待设置', loading: '检查中', ready: '待确认', uploading: '上传中', success: '已更新', error: '请检查' }[value] || ''
  }

  function restore() {
    revision += 1
    if (preview && preview !== original) { URL.revokeObjectURL(preview); urls.delete(preview) }
    preview = ''
    selected = null
    input.value = ''
    image.hidden = !original
    if (original) image.src = original
    else image.removeAttribute('src')
    card.dataset.hasCover = String(Boolean(original))
    save.hidden = cancel.hidden = true
    state('idle', '')
  }

  async function choose(file: File) {
    if (busy) return
    restore()
    const id = revision
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      state('error', '请选择 PNG、JPEG、GIF 或 WebP 图片。'); return
    }
    if (file.size > 2 * 1024 * 1024 || file.size === 0) {
      state('error', file.size ? '图片超过 2 MB，请压缩后再试。' : '这张图片是空文件，请重新选择。'); return
    }
    const url = URL.createObjectURL(file)
    urls.add(url)
    const probe = new Image()
    probe.src = url
    state('loading', '正在检查图片…')
    try { await probe.decode() } catch {
      URL.revokeObjectURL(url); urls.delete(url)
      if (id === revision) state('error', '无法读取这张图片，请换一张再试。')
      return
    }
    if (id !== revision) { URL.revokeObjectURL(url); urls.delete(url); return }
    selected = file
    preview = url
    image.src = url
    image.hidden = false
    card.dataset.hasCover = 'true'
    save.hidden = cancel.hidden = false
    state('ready', `${file.name} · ${Math.ceil(file.size / 1024)} KB · ${probe.naturalWidth} × ${probe.naturalHeight}`)
  }

  picks.forEach((button) => button.addEventListener('click', () => { if (!busy) input.click() }))
  input.addEventListener('change', () => { const file = input.files?.[0]; if (file) void choose(file) })
  cancel.addEventListener('click', () => { restore(); picks[0]?.focus() })
  card.addEventListener('dragenter', (event) => { event.preventDefault(); if (!busy) { dragDepth++; card.classList.add('is-dragging') } })
  card.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy' })
  card.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove('is-dragging') } })
  card.addEventListener('drop', (event) => {
    event.preventDefault(); dragDepth = 0; card.classList.remove('is-dragging')
    if (busy) return
    const files = event.dataTransfer?.files
    if (!files?.length) return
    if (files.length !== 1) { state('error', '每个分区一次选择一张图片。'); return }
    void choose(files[0])
  })
  save.addEventListener('click', async () => {
    if (!selected || busy) return
    busy = true
    card.setAttribute('aria-busy', 'true')
    input.disabled = save.disabled = cancel.disabled = true
    picks.forEach((button) => { button.disabled = true })
    save.textContent = '上传中…'
    state('uploading', '正在上传，请稍候…')
    let saved = false
    try {
      // 属性名以 action 结尾，复用 nginx 对 action="/ 的前缀替换。
      const response = await fetch(input.dataset.coverAction!, {
        method: 'POST', credentials: 'same-origin', body: selected,
        headers: { 'x-csrf-token': grid.dataset.coverCsrf!, 'x-requested-with': 'fetch', Accept: 'application/json' },
      })
      if (!response.ok || response.redirected) {
        state('error', response.status === 401 || response.status === 403 || response.redirected
          ? '登录状态已失效或没有权限，请刷新页面后重试。' : '上传失败，请检查图片或稍后重试。')
      } else {
        if (original.startsWith('blob:')) { URL.revokeObjectURL(original); urls.delete(original) }
        original = preview
        selected = null
        input.value = ''
        save.hidden = cancel.hidden = true
        state('success', '封面已更新，首页与频道横幅已同步。')
        saved = true
      }
    } catch { state('error', '网络连接中断，选图已保留，点击确认可重试。') }
    finally {
      busy = false
      card.removeAttribute('aria-busy')
      input.disabled = save.disabled = cancel.disabled = false
      picks.forEach((button) => { button.disabled = false })
      save.textContent = '确认更换'
      if (saved) picks[0]?.focus()
    }
  })
  window.addEventListener('pagehide', (event) => { if (!event.persisted) urls.forEach((url) => URL.revokeObjectURL(url)) })
})
