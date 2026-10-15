import { useEffect, useRef } from 'react';
import { IMAGE_ACCEPT } from '@/ui/rich/image-pipeline';

/**
 * headless 文件选择（D34）：业务代码不许手写 <input type=file>（gate:ui / 登记表规矩），
 * 这个件只提供 input 与「打开」句柄，选完把 FileList **原样**交出去 —— 不压缩、不加工、不预览。
 * 用法与 @/ui/rich/image-uploader 的 headless 同一种：onReady 在挂载期交回 open()，卸载时收回 null
 * （避免页面拿着失效引用去点）。移除由调用方自己管 state（这里没有内置列表）。
 */
export function FilePicker({ accept, multiple = false, onChange, onReady }: {
  /** 交给浏览器过滤；缺省 = 图片四件套（样例图这个用途） */
  accept?: string;
  multiple?: boolean;
  /** 选完回传（同一次选择的多个文件保持浏览器给定的顺序） */
  onChange: (files: File[]) => void;
  /** 「打开」句柄：挂载期交回，卸载收回 null */
  onReady?: (api: { open: () => void } | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onReady?.({ open: () => ref.current?.click() });
    return () => onReady?.(null);
  }, [onReady]);
  return (
    <input
      ref={ref}
      type='file'
      accept={accept ?? IMAGE_ACCEPT}
      multiple={multiple}
      className='hidden'
      onChange={(e) => {
        onChange(Array.from(e.target.files ?? []));
        // 读完就清：同一张图改完再选才还会触发 change
        if (ref.current) ref.current.value = '';
      }}
    />
  );
}
