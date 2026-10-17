// admin 容器的共享件：一屏一个容器（见 ./index 的说明）。errorLine 的真身在
// screens 也在用的 ../bits.tsx（devroom 这层同样要翻错误，D56 重置弹层就近显示）——
// 这里原样再出口，容器一行 import 都不用改。
//
// 这里原来还有一个 PendingScreen（端点没到时渲染「这一屏还没有可以对接的端点」）。C1/C2/C3 落地、
// 12 屏全接完之后它没有使用者了，所以删掉：**留着一个没人用的占位屏，下一个人就会以为还有哪一屏没接。**
export { errorLine } from '@/devroom/pages/15-admin/bits';
