<script setup lang="ts">
import { ref } from 'vue'
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

    <label class="field">类型（必选）
      <select v-model="kind">
        <option v-for="item in KINDS" :key="item.value" :value="item.value">
          {{ item.label }} —— {{ item.hint }}
        </option>
      </select>
    </label>

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
select,input,textarea{width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:none;color:inherit;font:inherit;font-size:14px}
.err{margin:0;color:#b91c1c;font-size:13px}
.actions{display:flex;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 18px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:inherit;font-size:14px;cursor:pointer}
.btn:disabled{opacity:.6;cursor:default}
.btn.ghost{background:none;border:1px solid var(--line,#e5e7eb);color:inherit;text-decoration:none}
</style>
