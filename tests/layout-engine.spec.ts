import { test, expect } from '@playwright/test';
import {
  arrangeLayouts,
  compactLayouts,
  overlaps,
  sameGeometry,
} from '../packages/widget-schema/src';
import type { Layout } from '../packages/protocol/src';
const card = (widgetId: string, x: number, y: number, w = 4, h = 3): Layout => ({
  widgetId,
  breakpoint: 'tablet',
  x,
  y,
  w,
  h,
});
test('布局引擎：交换、尺寸不同的碰撞、紧凑对齐与输入不可变', () => {
  const layouts = [card('a', 0, 0), card('b', 4, 0), card('c', 0, 3, 8, 4)];
  const original = JSON.stringify(layouts);
  const swapped = arrangeLayouts(layouts, { ...layouts[0], x: 4 }, 'b');
  expect(swapped[0].x).toBe(4);
  expect(swapped[1].x).toBe(0);
  expect(sameGeometry(swapped[2], layouts[2])).toBe(true);
  const enlarged = arrangeLayouts(layouts, { ...layouts[0], w: 8, h: 5 });
  for (const a of enlarged)
    for (const b of enlarged) if (a !== b) expect(overlaps(a, b)).toBe(false);
  const packed = compactLayouts([card('a', 0, 9), card('b', 4, 12), card('c', 0, 19, 8, 4)]);
  expect(packed.map((l) => [l.x, l.y])).toEqual([
    [0, 0],
    [4, 0],
    [0, 3],
  ]);
  expect(JSON.stringify(layouts)).toBe(original);
});
