import { assetUrl } from '@/lib/url';
import { cn } from '@/lib/utils';

/**
 * **全站唯一的默认封面**（用户 2026-10-15 拍板）。
 *
 * 原来没有封面时落的是「**分区首字 + 由 slug 定的色相**」—— 首页卡片上就是一个大大的「原」「工」「自」。
 * 用户判定那**不是他要的**（原话：「完全没有关联的字」），改成美术资产里的一张弥音图。
 * 于是从「有语义的字」退成「一张中性的画」：它只是把空位填满，不声称任何事。
 *
 * 选 `miyin-portrait-320.webp`（`web/public/art/`，SOURCES.md 里它是「弥音头像立绘」那一张）：
 *   · **封面位是宽幅**（卡片 16:9、后台缩略图 96×56、侧栏 20–56 的方格）。它是方图，靠 object-cover 居中裁 ——
 *     这一张是**正面居中胸像**，裁到 16:9 后两只眼睛都在、脸还在正中，主体没被裁掉；
 *     对比过的其它张：smile-160 在 4:1 窄条上只剩一条闭眼的弧线，welcome-400 在小方格里脸被切掉下半。
 *   · **画面对比度是这批里最高的**（实测 L=197 / sd=36，其余 207–238 / 22–27）——
 *     淡彩的几张铺在卡片上会糊成一张白纸，看起来像「图没加载出来」。它带紫色背景，一眼是张画。
 *   · 320×320（≈14KB）在真实封面位（首页卡片 256 逻辑像素、2x 屏 512）是**最小够用**的那一档，
 *     再小的几张放上去就是放大糊图 —— 与 TopicCover 的 MIN_COVER_WIDTH=320 同一条尺子。
 *
 * **两条拼法不许混**（D27 就是这么裂的图）：
 *   · 这里走 `assetUrl()` —— public/art 下的静态素材；
 *   · 真封面是**图片端点**的资源，走 `imagePath('/img/' + cover_hash)`。
 */
export const DEFAULT_COVER_ART = 'miyin-portrait-320.webp';

/**
 * 铺满**调用方给的格子**：尺寸/圆角/边框都由外面定，这里只管「画满 + 裁得好看」。
 * 所以调用方的容器必须有定位（`relative`/`grid` 都行），并且**不能是空壳** —— 空壳里它会撑不开。
 */
export function DefaultCover({ className }: { className?: string }) {
  return (
    <img
      src={assetUrl(DEFAULT_COVER_ART)}
      alt=''
      aria-hidden
      loading='lazy'
      decoding='async'
      className={cn('absolute inset-0 size-full object-cover object-[50%_38%] select-none', className)}
    />
  );
}
