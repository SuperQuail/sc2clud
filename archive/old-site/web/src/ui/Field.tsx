import type { ReactNode } from 'react'

export interface FieldProps {
  label: string
  hint?: string
  children: ReactNode
}

/** 表单一行：标签在上，控件在中间，提示在下。 */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      {children}
      {hint ? <p className="ui-hint">{hint}</p> : null}
    </label>
  )
}
