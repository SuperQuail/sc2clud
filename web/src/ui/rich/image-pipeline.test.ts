import { describe, expect, it } from 'vitest';
import { planImages } from './image-pipeline';

// 限额规则是纯计算，必须锁住：点选与拖拽都靠它，错了会静默丢图。
describe('planImages', () => {
  it('还有余额时全收', () => {
    expect(planImages(2, { existing: 3, max: 10 })).toEqual({ room: 7, dropped: 0 });
  });

  it('超出上限的部分算丢弃', () => {
    expect(planImages(5, { existing: 8, max: 10 })).toEqual({ room: 2, dropped: 3 });
  });

  it('已满时一张也不收', () => {
    expect(planImages(3, { existing: 10, max: 10 })).toEqual({ room: 0, dropped: 3 });
  });

  it('默认上限是 10', () => {
    expect(planImages(1, { existing: 0 }).room).toBe(10);
  });
});
