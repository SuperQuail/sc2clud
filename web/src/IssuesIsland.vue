<script setup lang="ts">
// 组件行为（键盘 / 焦点 / ARIA / 滚动锁定）交给 Reka UI，外观仍用本站的样式 —— 见 AGENTS §6.6
import { ref } from 'vue'
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectViewport,
} from 'reka-ui'
import { createIssue, type IssueKind } from './issues-api'

const props = defineProps<{
  postId: number
  csrf: string
  /** 从哪个入口进来（报告 Bug / 改进意见 / 难度建议 / 通用），用来预选类型 */
  defaultKind: IssueKind
}>()

const KINDS: { value: IssueKind; label: string; hint: string }[] = [
  { value: 'bug', label: '报告 Bug', hint: '打不开、崩溃、闪退、卡关' },
  { value: 'feature', label: '改进意见', hint: '希望新增或调整的功能' },
  { value: 'difficulty', label: '难度建议', hint: '太简单 / 太难 / 想要难度选项' },
  { value: 'other', label: '其它', hint: '不属于上面三类的问题' },
]

const kind = ref<IssueKind>(props.defaultKind)
const title = ref('')
const body = ref('')
const busy = ref(false)
const error = ref('')

const current = () => KINDS.find((item) => item.value === kind.value) ?? KINDS[3]

async function submit() {
  if (!title.value.trim()) {
    error.value = '标题不能为空'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await createIssue(props.postId, {
      kind: kind.value,
      title: title.value.trim(),
      body: body.value.trim(),
      csrf: props.csrf,
    })
    location.href = `/p/${props.postId}/issues`
  } catch (e) {
    error.value = e instanceof Error ? e.message : '提交失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="issue-new" @submit.prevent="submit">
    <h2>发布反馈</h2>
    <p class="hint">选一个类型，写清现象或想法；提交后作者与管理员都会看到。</p>

    <div class="field">
      <span class="label">类型（必选）</span>
      <SelectRoot v-model="kind">
        <SelectTrigger class="trigger" aria-label="反馈类型">
          <span><b>{{ current().label }}</b> —— {{ current().hint }}</span>
          <SelectIcon class="caret" />
        </SelectTrigger>
        <SelectPortal>
          <SelectContent class="menu" position="popper" :side-offset="6">
            <SelectViewport>
              <SelectItem v-for="item in KINDS" :key="item.value" :value="item.value" class="item">
                <SelectItemText>
                  <b>{{ item.label }}</b> —— {{ item.hint }}
                </SelectItemText>
                <SelectItemIndicator class="tick">✓</SelectItemIndicator>
              </SelectItem>
            </SelectViewport>
          </SelectContent>
        </SelectPortal>
      </SelectRoot>
    </div>

    <label class="field">标题
      <input v-model="title" type="text" maxlength="80" placeholder="一句话说清问题，例如：第三关开局就崩溃">
    </label>

    <label class="field">正文
      <textarea v-model="body" rows="8" maxlength="5000" placeholder="复现步骤 / 你的版本 / 期望的行为。写清这些，作者才好定位。"></textarea>
    </label>

    <p v-if="error" class="err">{{ error }}</p>
    <div class="actions">
      <button class="btn" type="submit" :disabled="busy">{{ busy ? '提交中…' : '提交反馈' }}</button>
      <a class="btn ghost" :href="`/p/${postId}/issues`">取消</a>
    </div>
  </form>
</template>

<style scoped>
.issue-new{display:flex;flex-direction:column;gap:14px}
.issue-new h2{margin:0;font-size:18px}
.hint{margin:0;font-size:13px;opacity:.8}
.field{display:block;font-size:14px}
.label{display:block;margin-bottom:6px}
input,textarea{width:100%;padding:10px 12px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:none;color:inherit;font:inherit;font-size:14px}
/* 自定义下拉：触发器 + 浮层菜单，外观沿用本站圆角与配色 */
.trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:10px 12px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:none;color:inherit;font:inherit;font-size:14px;cursor:pointer;text-align:left}
.trigger:hover{border-color:#93c5fd}
.trigger[data-state=open]{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.caret{width:10px;height:10px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);opacity:.6}
.menu{z-index:60;min-width:var(--reka-select-trigger-width);background:var(--bg,#fff);border:1px solid var(--line,#e5e7eb);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:4px;animation:pop .12s ease-out}
@keyframes pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:8px;font-size:14px;cursor:pointer;outline:none}
.item[data-highlighted]{background:rgba(37,99,235,.1);color:#1d4ed8}
.tick{color:#2563eb;font-weight:700}
.err{margin:0;color:#b91c1c;font-size:13px}
.actions{display:flex;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 18px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:inherit;font-size:14px;cursor:pointer}
.btn:disabled{opacity:.6;cursor:default}
.btn.ghost{background:none;border:1px solid var(--line,#e5e7eb);color:inherit;text-decoration:none}
</style>
