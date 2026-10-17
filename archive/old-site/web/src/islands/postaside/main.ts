// 帖子页右栏岛：复制原链 + 镜像测速（行为写在 web/src/lib/postaside.ts）
// 这块没有自己的 DOM，也就不需要挂载点——空挂载点会占 .post-layout 的网格位。
import { bindPostAside } from '../../lib/postaside'

bindPostAside()
