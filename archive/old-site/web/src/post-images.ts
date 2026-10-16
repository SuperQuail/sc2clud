// 只接管帖子配图；头像、站点插画与没有封面的帖子继续使用原有样式。
const fallbackName = '../art/' + 'miyin/image-unavailable-480.webp'
const fallbackUrl = new URL(fallbackName, import.meta.url).href

function showFallback(image: HTMLImageElement) {
  if (!image.hasAttribute('data-post-image') || image.dataset.imageFallback === 'true') return
  // 先标记再换 src，防止占位图本身失效时递归请求。
  image.dataset.imageFallback = 'true'
  image.classList.add('post-image-unavailable')
  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  image.alt = '图片暂时无法显示，请稍后重试'
  image.title = image.alt
  image.src = fallbackUrl
}

// 捕获不会冒泡的 error；也覆盖后续加入论坛阅读面板的配图。
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement) showFallback(event.target)
}, true)

// 模块执行前已失效的缓存图片同样需要处理；尚未开始的懒加载图片不替换。
document.querySelectorAll<HTMLImageElement>('img[data-post-image]').forEach(image => {
  if (image.complete && image.naturalWidth === 0 && image.currentSrc) showFallback(image)
})
