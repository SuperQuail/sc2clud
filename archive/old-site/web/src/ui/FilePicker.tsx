import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Button } from './Button'

/** 默认只收后端魔数校验放行的四类图片（PNG / JPEG / GIF / WebP）。 */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
/** 与后端 to_bytes 的读取上限一致：超了就白传一趟。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** 外部（例如封面预览那片）想打开选择框时用它，省得各自去点隐藏的 input。 */
export interface FilePickerHandle {
  open: () => void
}

export interface FilePickerProps {
  /** 控件名（hideLabel 时只给读屏用） */
  label: string
  /** 选中的文件（受控；null = 未选） */
  file: File | null
  /** 选中或清空（校验不通过时回 null，错误显示在控件里） */
  onPick: (file: File | null) => void
  /** 触发按钮文案 */
  buttonLabel?: string
  /** 提示（按钮下方） */
  hint?: string
  accept?: string
  maxBytes?: number
  /** 上传中禁用 */
  disabled?: boolean
  /** 标签只在读屏里出现（嵌在紧凑的行里时用） */
  hideLabel?: boolean
}

function describeAccept(accept: string): string {
  const names: Record<string, string> = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
  }
  return accept.split(',').map((type) => names[type.trim()] ?? type.trim()).join(' / ')
}

/**
 * 文件选择控件：一个按钮 + 隐藏的原生 input（不再露出「选择文件/未选择文件」），
 * 选中后就地显示文件名、体积与缩略图；类型与体积在这里先挡一道，错误显示在控件内。
 */
export const FilePicker = forwardRef<FilePickerHandle, FilePickerProps>(function FilePicker(
  {
    label,
    file,
    onPick,
    buttonLabel = '选择图片',
    hint,
    accept = IMAGE_ACCEPT,
    maxBytes = DEFAULT_MAX_BYTES,
    disabled,
    hideLabel,
  },
  ref,
) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [thumb, setThumb] = useState('')
  const [dragging, setDragging] = useState(false)

  useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), [])

  // 缩略图用 blob URL：换文件与卸载都要撤销（否则这张图一直占着内存）
  useEffect(() => {
    if (!file) {
      setThumb('')
      return
    }
    const url = URL.createObjectURL(file)
    setThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function choose(picked: File | null) {
    if (!picked) return
    if (!accept.split(',').map((type) => type.trim()).includes(picked.type)) {
      setError('只支持 ' + describeAccept(accept) + '，请换一张。')
      onPick(null)
      return
    }
    if (picked.size === 0) {
      setError('这张图片是空文件，请重新选择。')
      onPick(null)
      return
    }
    if (picked.size > maxBytes) {
      setError('图片超过 ' + Math.round(maxBytes / 1024 / 1024) + ' MB，请压缩后再试。')
      onPick(null)
      return
    }
    setError('')
    onPick(picked)
  }

  return (
    <div
      className={'ui-filepicker' + (dragging ? ' is-dragging' : '')}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true) }}
      onDragOver={(event) => { event.preventDefault() }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (disabled) return
        const files = event.dataTransfer?.files
        if (!files || files.length === 0) return
        if (files.length > 1) {
          setError('一次只能选一张图片。')
          return
        }
        choose(files[0])
      }}
    >
      <span className={hideLabel ? 'ui-label-sr' : 'ui-label'}>{label}</span>
      <div className="ui-filepicker-row">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => input.current?.click()}>
          {buttonLabel}
        </Button>
        {file && thumb ? (
          <span className="ui-filepicker-file">
            <img className="ui-filepicker-thumb" src={thumb} alt="" />
            <span className="ui-filepicker-name" title={file.name}>
              {file.name} · {Math.ceil(file.size / 1024)} KB
            </span>
          </span>
        ) : null}
      </div>
      {hint ? <p className="ui-hint">{hint}</p> : null}
      {error ? <p className="ui-filepicker-error" role="alert">{error}</p> : null}
      <input
        ref={input}
        className="ui-filepicker-input"
        type="file"
        accept={accept}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null
          // 清掉 value：否则「选同一个文件」不会再触发 change
          event.target.value = ''
          choose(picked)
        }}
      />
    </div>
  )
})
