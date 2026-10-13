import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES, planImages, POST_IMAGE_MAX_BYTES } from './image-pipeline';

// 造一个只有体积有意义的 File：管线只读 name 与 size，所以**真分配 12MB 字节是浪费**，
// 直接给一个同形状的替身（只断言这两个字段，不需要它真的是 Blob）。
function file(name: string, bytes: number): File {
  return { name, size: bytes, type: 'image/png' } as unknown as File;
}

// 限额规则是纯计算，必须锁住：点选与拖拽都靠它，错了会静默丢图。
describe('planImages', () => {
  it('还有余额时全收', () => {
    expect(planImages({ existing: 3, max: 10, files: [file('a.png', 1024), file('b.png', 2048)] })).toEqual({ room: 7, dropped: 0, tooBig: null });
  });

  it('超出上限的部分算丢弃', () => {
    const files = Array.from({ length: 5 }, (_, i) => file('p' + i + '.png', 1024));
    expect(planImages({ existing: 8, max: 10, files })).toEqual({ room: 2, dropped: 3, tooBig: null });
  });

  it('已满时一张也不收', () => {
    const files = Array.from({ length: 3 }, (_, i) => file('q' + i + '.png', 1024));
    expect(planImages({ existing: 10, max: 10, files })).toEqual({ room: 0, dropped: 3, tooBig: null });
  });

  it('默认上限是 10', () => {
    expect(planImages({ existing: 0 }).room).toBe(10);
  });

  // 盲审二号 2026-10-13：给头像位塞 12MB 的图，提示却是「最多 1 张」——**体积文案被张数文案盖掉了**。
  it('12MB 的图塞进只收 1 张的头像位：报体积过大，而不是张数超限', () => {
    const big = file('huge.png', 12 * 1024 * 1024);
    const plan = planImages({ existing: 0, max: 1, maxBytes: AVATAR_MAX_BYTES, files: [big] });
    expect(plan.tooBig).toEqual({ name: 'huge.png', size: 12 * 1024 * 1024 });
    expect(plan.dropped).toBe(0); // 过大不算「装不下的正常图」，否则文案又会退回张数
  });

  it('正好等于上限的文件收下，超一个字节的才拒', () => {
    expect(planImages({ existing: 0, maxBytes: AVATAR_MAX_BYTES, files: [file('ok.png', AVATAR_MAX_BYTES)] }).tooBig).toBeNull();
    expect(planImages({ existing: 0, maxBytes: AVATAR_MAX_BYTES, files: [file('bad.png', AVATAR_MAX_BYTES + 1)] }).tooBig).not.toBeNull();
  });

  // 这条要能抓住「过大也占名额」那个写法：只有一个名额时，12MB 的那张要是把名额占了，
  // 后面 5MB 的图就被挤掉、dropped 变成 1（真实行为是它照样进得来）。
  it('过大的文件不占名额：它后面的正常图仍然进得来', () => {
    const plan = planImages({ existing: 0, max: 1, maxBytes: AVATAR_MAX_BYTES, files: [file('huge.png', 12 * 1024 * 1024), file('fine.png', 5 * 1024 * 1024)] });
    expect(plan.room).toBe(1);
    expect(plan.dropped).toBe(0);
    expect(plan.tooBig?.name).toBe('huge.png');
  });

  it('配图上限与头像上限是两个数（默认按配图算）', () => {
    const elevenMb = file('phone.jpg', 11 * 1024 * 1024);
    expect(planImages({ existing: 0, max: 10, files: [elevenMb] }).tooBig).toBeNull();
    expect(planImages({ existing: 0, max: 10, maxBytes: AVATAR_MAX_BYTES, files: [elevenMb] }).tooBig).not.toBeNull();
    expect(POST_IMAGE_MAX_BYTES).toBeGreaterThan(AVATAR_MAX_BYTES);
  });
});
