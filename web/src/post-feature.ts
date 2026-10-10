// 精华表单独立增强，保留无脚本时的普通提交。
for (const form of document.querySelectorAll<HTMLFormElement>('[data-feature-form]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    if (button.disabled) return
    const target = form.elements.namedItem('featured') as HTMLInputElement
    const note = form.querySelector<HTMLElement>('[data-feature-note]')!
    button.disabled = true
    form.setAttribute('aria-busy', 'true')
    note.textContent = ''
    try {
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form) as unknown as Record<string, string>),
      })
      if (!response.ok) throw new Error('操作未完成，请刷新页面确认状态后再试。')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('featured' in result) || typeof result.featured !== 'boolean') {
        throw new Error('状态未确认，请刷新页面查看。')
      }
      const featured = result.featured
      document.querySelectorAll<HTMLElement>('[data-feature-badge]').forEach((badge) => { badge.hidden = !featured })
      target.value = featured ? '0' : '1'
      button.textContent = featured ? '取消精华' : '设为精华'
      if (!featured && form.dataset.featureAddAllowed === 'false') form.remove()
    } catch (error) {
      note.textContent = error instanceof Error && error.message.startsWith('状态')
        ? error.message : '操作未完成，请刷新页面确认状态后再试。'
    } finally {
      button.disabled = false
      form.setAttribute('aria-busy', 'false')
    }
  })
}
