<script setup lang="ts">
// 上传岛：进度条只能用 XHR（fetch 不暴露上传进度），秒传由服务端校验。
import { ref } from 'vue'

interface UploadResult {
  id: number
  name: string
  size: number
  hash: string
  deduplicated: boolean
  download_url: string
}

const file = ref<File | null>(null)
const busy = ref(false)
const percent = ref(0)
const status = ref('')
const failure = ref('')
const result = ref<UploadResult | null>(null)

function pick(event: Event) {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
  status.value = ''
  failure.value = ''
  result.value = null
}

function upload() {
  const selected = file.value
  if (!selected || busy.value) return

  busy.value = true
  percent.value = 0
  status.value = ''
  failure.value = ''

  const query = new URLSearchParams({
    name: selected.name,
    mime: selected.type || 'application/octet-stream',
  })
  const xhr = new XMLHttpRequest()
  xhr.open('PUT', `/api/v1/files?${query.toString()}`)

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      percent.value = Math.round((event.loaded / event.total) * 100)
    }
  }

  xhr.onload = () => {
    busy.value = false
    if (xhr.status >= 200 && xhr.status < 300) {
      const parsed = JSON.parse(xhr.responseText) as UploadResult
      result.value = parsed
      status.value = parsed.deduplicated ? '命中秒传：未重复占用磁盘' : '上传完成'
    } else {
      failure.value = describeFailure(xhr)
    }
  }
  xhr.onerror = () => {
    busy.value = false
    failure.value = '网络中断，上传未完成'
  }

  xhr.send(selected)
}

function describeFailure(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { message?: string }
    if (body.message) return body.message
  } catch {
    // 响应不是 JSON：退回状态码
  }
  return `上传失败（HTTP ${xhr.status}）`
}
</script>

<template>
  <form class="uploader" @submit.prevent="upload">
    <input type="file" :disabled="busy" @change="pick" />
    <button class="btn" type="submit" :disabled="busy || !file">{{ busy ? '上传中…' : '上传' }}</button>
    <progress v-if="busy || percent > 0" :value="percent" max="100"></progress>
    <p class="hint">
      {{ failure || status || '选择文件后上传；同内容命中秒传，不重复占盘。' }}
    </p>
    <p v-if="result" class="hint">
      <a :href="`/f/${result.id}`">{{ result.name }}</a>
      <span> · {{ result.hash.slice(0, 12) }}… · {{ percent }}%</span>
    </p>
  </form>
</template>
