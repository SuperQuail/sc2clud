import { useState, type ReactNode } from 'react';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { COMPRESS_LABEL } from '@/ui/rich/image-pipeline';
import { imagePath } from '@/lib/url';

// 「头像」这一块**一处实现、两处渲染**（上线设计 P2 决策 2）：
// DevRoom 11-profile 的设置标签（选中即本地预览）与真站 /settings（POST/DELETE /me/avatar）。
// 两侧只有「选完之后干什么」不同 —— 那部分由调用方给（onChange 拿字节、actions 放真站的保存/移除）。
export type AvatarSettingProps = {
  /** 当前头像：服务端 /img/<hash> 的 URL，或刚选中的本地预览 URL */
  avatar?: string | null;
  /** 选中（或移除）之后的新选择；空数组 = 用户点了移除 */
  onChange: (next: UploadedImage[]) => void;
  /** hero 上的「更换头像」用它代点，不必把上传器挪出面板 */
  onReady?: (api: { open: () => void } | null) => void;
  /** 真站的「保存头像 / 移除头像」；房间不传（选中就已经是结果了） */
  actions?: ReactNode;
};

export function AvatarSetting({ avatar, onChange, onReady, actions }: AvatarSettingProps) {
  // 提示归宿主画（上传器内部不再画那一行，否则同一句话会出现两次 —— D1）。
  // 这条正好是「12MB 的图塞进头像位要说清是体积问题」那个用例的落点。
  const [error, setError] = useState<string | null>(null);
  return (
    <div className='flex flex-col gap-3'>
      <ImageUploader
        variant='avatar'
        label='上传头像'
        compress
        // D23：选完先弹裁剪框选启用区域（非正方形/主体偏一边的图，不裁就会被圆形头像切掉四边）
        crop
        onError={setError}
        // 现头像塞进唯一的预览位：image-uploader 对 avatar 形态是**换掉**它，不是「名额已满」
        images={avatar ? [{ id: 'me', name: 'avatar.webp', size: 0, url: imagePath(avatar), original: false, file: new Blob() }] : []}
        onChange={onChange}
        onReady={onReady}
      />
      <span className='text-[11px] leading-relaxed text-muted-foreground'>
        方形图最好看。{COMPRESS_LABEL}；头像成品目标 ≤64KB（服务端硬上限 128KB），所以原图大一点也传得进来。
      </span>
      {error ? (
        <span role='alert' className='text-[12px] text-destructive'>
          {error}
        </span>
      ) : null}
      {actions ? <span className='flex flex-wrap items-center gap-2'>{actions}</span> : null}
    </div>
  );
}
