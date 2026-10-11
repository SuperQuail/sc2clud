import io, re, json
p = r'D:\Code\Rust\SC2clud\site\crates\sc2clud-web\src\routes.rs'
src = io.open(p, encoding='utf-8').read()
lines = src.split('\n')
print('routes.rs 行数:', len(lines))
targets = ['pub(crate) fn sniff_image_mime', 'pub async fn upload_post_image', 'pub async fn serve_image']
out = {}
for t in targets:
    i = src.index(t)
    start_line = src[:i].count('\n')
    j = src.index('\n}\n', i) + 3
    end_line = src[:j].count('\n')
    block = src[i:j]
    out[t] = (start_line, end_line, len(block.split('\n')))
    print(f'  {t}: 行 {start_line+1}-{end_line}, {len(block.split(chr(10)))} 行, {len(block)} 字节')
    # 该块里引用到的本文件符号（用于判断要带哪些 import）
    ids = sorted(set(re.findall(r'\b(client_subject|invalid|pump_body|DEFAULT_QUEUE_DEPTH|sniff_image_mime|ensure_free_space|require_user|render_template)\b', block)))
    print('    用到:', ', '.join(ids))
print()
print('=== 这些符号在 routes.rs 的定义位置 ===')
for name in ['client_subject', 'invalid', 'render_template']:
    idx = src.find('fn ' + name)
    print(f'  {name}: 行 {src[:idx].count(chr(10))+1}')
print()
print('=== serve_image 的当前行为摘要 ===')
i = src.index('pub async fn serve_image')
blk = src[i:i+2600]
for ln in blk.split('\n')[:14]:
    print('   ', ln[:110])