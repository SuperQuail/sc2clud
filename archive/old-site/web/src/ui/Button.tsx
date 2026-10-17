import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle'
type Size = 'sm' | 'md'

interface BaseProps {
  variant?: Variant
  size?: Size
  /** 占满整行 */
  block?: boolean
  /** 左侧图标（Heroicons 内联 SVG 或任意节点） */
  icon?: ReactNode
  children?: ReactNode
}

export type ButtonProps = BaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    /** 传了 href 就渲染成链接（语义正确），否则是 button */
    href?: string
    loading?: boolean
  }

function cls(variant: Variant, size: Size, block?: boolean, extra = '') {
  return ['ui-btn', `ui-btn-${size}`, block ? 'ui-btn-block' : '', extra]
    .filter(Boolean)
    .join(' ')
}

/**
 * 我们的按钮：一个组件覆盖「主/次/危险/低调 × 两种尺寸 × 图标 × 加载态 × 链接」。
 * 外观在 ui.css，行为就是原生元素。
 */
export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', block, icon, loading, href, className = '', children, ...rest } = props
  const className2 = cls(variant, size, block, className)
  const content = (
    <>
      {loading ? <span className="ui-btn-spin" aria-hidden="true" /> : icon}
      {children}
    </>
  )
  if (href) {
    const anchor = rest as AnchorHTMLAttributes<HTMLAnchorElement>
    return (
      <a className={className2} data-variant={variant} href={href} {...anchor}>
        {content}
      </a>
    )
  }
  const button = rest as ButtonHTMLAttributes<HTMLButtonElement>
  return (
    <button className={className2} data-variant={variant} disabled={loading || button.disabled} {...button}>
      {content}
    </button>
  )
}
