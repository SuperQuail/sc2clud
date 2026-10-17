// 下载来源的数据形状与纯函数（控件与页面共用，不依赖 React）

export interface SourceProvider {
  value: string
  label: string
}

export interface SourceSlot {
  provider: string
  label: string
  code: string
  url: string
}

export function emptySource(provider: string): SourceSlot {
  return { provider, label: '', code: '', url: '' }
}

/** 服务端保存时会忽略整行留空的来源，这里用同一规则判断「有没有内容」 */
export function hasContent(slot: SourceSlot): boolean {
  return slot.url.trim().length > 0
}
