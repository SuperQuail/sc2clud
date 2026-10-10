import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children?: ReactNode
}

/** 我们的按钮：样式在 ui.css，行为就是原生 button（不做无意义的包装）。 */
export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  return <button className={`ui-btn ${className}`.trim()} data-variant={variant} {...rest} />
}
