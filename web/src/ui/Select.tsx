import * as Select from '@radix-ui/react-select'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  'aria-label'?: string
}

/**
 * 我们的下拉：**行为全部交给 Radix**（键盘、焦点、ARIA、滚动锁定、portal 定位），
 * 我们只提供外观与用法。以后所有下拉都用它，不要再写原生 select。
 */
export function SelectBox({ value, onChange, options, ...rest }: SelectProps) {
  const current = options.find((item) => item.value === value) ?? options[0]
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="ui-select-trigger" aria-label={rest['aria-label']}>
        <span>{current ? current.label : ''}</span>
        <Select.Icon className="ui-select-caret" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="ui-select-content" position="popper" sideOffset={6}>
          <Select.Viewport className="ui-select-viewport">
            {options.map((item) => (
              <Select.Item key={item.value} value={item.value} className="ui-select-item">
                <Select.ItemText>{item.hint ? `${item.label} —— ${item.hint}` : item.label}</Select.ItemText>
                <Select.ItemIndicator className="ui-select-tick">✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
