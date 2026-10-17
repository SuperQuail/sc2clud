// 头像编辑器（纯 TS，不引 Vue：这点交互不值得带上运行时）。
//
// 关键约束：**压缩发生在浏览器**。服务端只收 ≤64KB 的成品，
// 2 vCPU 的机器不把算力花在图片转码上。流程：
//   选图 → 画到 320×320 画布（拖动平移 / 滚轮或滑块缩放）→
//   导出 256×256，WebP 质量从 0.9 逐档降到 0.4，仍超标就再缩边长 → POST。

const MAX_BYTES = 64 * 1024
const CANVAS = 320
const OUT = 256

type State = {
  img: HTMLImageElement
  scale: number
  x: number
  y: number
}

function clamp(state: State) {
  const w = state.img.naturalWidth * state.scale
  const h = state.img.naturalHeight * state.scale
  const minX = CANVAS - w
  const minY = CANVAS - h
  state.x = Math.min(0, Math.max(minX, state.x))
  state.y = Math.min(0, Math.max(minY, state.y))
}

function paint(canvas: HTMLCanvasElement, state: State) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, CANVAS, CANVAS)
  ctx.fillStyle = '#00000010'
  ctx.fillRect(0, 0, CANVAS, CANVAS)
  clamp(state)
  ctx.drawImage(
    state.img,
    state.x,
    state.y,
    state.img.naturalWidth * state.scale,
    state.img.naturalHeight * state.scale,
  )
  ctx.strokeStyle = 'rgba(47,111,228,.9)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, CANVAS - 2, CANVAS - 2)
}

async function encode(state: State): Promise<Blob | null> {
  const side = CANVAS / state.scale
  const sx = -state.x / state.scale
  const sy = -state.y / state.scale
  for (const size of [OUT, 192, 160, 128]) {
    const off = document.createElement('canvas')
    off.width = size
    off.height = size
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(state.img, sx, sy, side, side, 0, 0, size, size)
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        off.toBlob((b) => resolve(b), 'image/webp', quality),
      )
      if (blob && blob.size <= MAX_BYTES) return blob
    }
  }
  return null
}

function mount() {
  const host = document.querySelector('[data-island="avatar"]') as HTMLElement | null
  if (!host) return
  const csrf = host.dataset.csrf || ''
  const input = document.getElementById('avatar-input') as HTMLInputElement | null
  const crop = document.getElementById('avatar-crop') as HTMLElement | null
  const canvas = document.getElementById('avatar-canvas') as HTMLCanvasElement | null
  const zoom = document.getElementById('avatar-zoom') as HTMLInputElement | null
  const save = document.getElementById('avatar-save') as HTMLButtonElement | null
  const cancel = document.getElementById('avatar-cancel') as HTMLButtonElement | null
  const status = document.getElementById('avatar-status') as HTMLElement | null
  if (!input || !crop || !canvas || !zoom || !save || !cancel) return

  let state: State | null = null
  const say = (text: string) => {
    if (status) status.textContent = text
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      // 初始缩放：让短边刚好铺满画布
      const initial = CANVAS / Math.min(img.naturalWidth, img.naturalHeight)
      state = {
        img,
        scale: initial,
        x: (CANVAS - img.naturalWidth * initial) / 2,
        y: (CANVAS - img.naturalHeight * initial) / 2,
      }
      zoom.min = String(initial)
      zoom.max = String(initial * 4)
      zoom.step = String(initial / 50)
      zoom.value = String(initial)
      crop.hidden = false
      paint(canvas, state)
      say('拖动图片调整位置')
    }
    img.src = url
  })

  zoom.addEventListener('input', () => {
    if (!state) return
    const next = Number(zoom.value)
    // 以画布中心为基准缩放，手感稳定
    const cx = (CANVAS / 2 - state.x) / state.scale
    const cy = (CANVAS / 2 - state.y) / state.scale
    state.scale = next
    state.x = CANVAS / 2 - cx * next
    state.y = CANVAS / 2 - cy * next
    paint(canvas, state)
  })

  let dragging = false
  let lastX = 0
  let lastY = 0
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || !state) return
    state.x += event.clientX - lastX
    state.y += event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    paint(canvas, state)
  })
  const stop = () => {
    dragging = false
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  canvas.addEventListener('wheel', (event) => {
    if (!state) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.08 : 0.92
    zoom.value = String(Number(zoom.value) * factor)
    zoom.dispatchEvent(new Event('input'))
  })

  cancel.addEventListener('click', () => {
    state = null
    input.value = ''
    crop.hidden = true
    say('')
  })

  save.addEventListener('click', async () => {
    if (!state) return
    say('压缩中…')
    const blob = await encode(state)
    if (!blob) {
      say('这张图压不到 64 KB，换一张试试')
      return
    }
    say(`上传中（${Math.round(blob.size / 1024)} KB）…`)
    try {
      // 站点可能挂在路径前缀下（测试实例 /dev）；岛的 JS 由静态直出，nginx 的
  // sub_filter 覆盖不到，所以这里自己算前缀。
  const prefix = location.pathname.startsWith('/dev') ? '/dev' : ''
  const response = await fetch(prefix + '/api/v1/me/avatar', {
        method: 'POST',
        headers: { 'content-type': 'image/webp', 'x-csrf-token': csrf },
        body: blob,
      })
      if (!response.ok) {
        say('上传失败：' + response.status)
        return
      }
      say('已更新，正在刷新…')
      location.reload()
    } catch (error) {
      say('上传出错：' + String(error))
    }
  })
}

mount()
