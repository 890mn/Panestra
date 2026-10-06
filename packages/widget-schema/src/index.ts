import type { Breakpoint, Layout } from '../../protocol/src/index';
export const COLUMNS: Record<Breakpoint, number> = { desktop: 12, tablet: 8, mobile: 4 };
export const constraints = { minW: 2, minH: 2, maxH: 12 };
export function clampLayout(layout: Layout): Layout {
  const cols = COLUMNS[layout.breakpoint];
  const w = Math.max(2, Math.min(cols, Math.round(layout.w)));
  return {
    ...layout,
    x: Math.max(0, Math.min(cols - w, Math.round(layout.x))),
    y: Math.max(0, Math.min(10000, Math.round(layout.y))),
    w,
    h: Math.max(2, Math.min(12, Math.round(layout.h))),
    detached: true,
  };
}
export function deriveLayout(widgetId: string, breakpoint: Breakpoint, index: number): Layout {
  const cols = COLUMNS[breakpoint];
  return {
    widgetId,
    breakpoint,
    x: 0,
    y: index * 3,
    w: breakpoint === 'desktop' ? 4 : cols,
    h: 3,
    detached: false,
  };
}
export const ROW_HEIGHT = 84;
export const GRID_GAP = 16;
export type LayoutRecord = { layout: Layout; rev: number };
export function sameGeometry(a: Layout, b: Layout) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.breakpoint === b.breakpoint;
}
export function overlaps(a: Layout, b: Layout) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
/** Keep the requested card anchored; other cards move down to the first free row. */
export function arrangeLayouts(layouts: Layout[], desired: Layout, swapId?: string): Layout[] {
  const original = layouts.find((l) => l.widgetId === desired.widgetId);
  if (!original) return layouts;
  const target = layouts.find((l) => l.widgetId === swapId && l.widgetId !== desired.widgetId);
  const anchor = clampLayout(target ? { ...desired, x: target.x, y: target.y } : desired);
  const others = layouts
    .filter((l) => l.widgetId !== desired.widgetId)
    .map((l) =>
      target?.widgetId === l.widgetId
        ? clampLayout({ ...l, x: original.x, y: original.y })
        : { ...l },
    );
  others.sort((a, b) =>
    a.widgetId === b.widgetId
      ? 0
      : a.widgetId === swapId
        ? -1
        : b.widgetId === swapId
          ? 1
          : a.y - b.y || a.x - b.x || a.widgetId.localeCompare(b.widgetId),
  );
  const placed = [anchor];
  for (let item of others) {
    for (let attempts = 0; attempts <= layouts.length; attempts++) {
      const hits = placed.filter((l) => overlaps(l, item));
      if (!hits.length) break;
      item = { ...item, y: Math.max(...hits.map((l) => l.y + l.h)), detached: true };
    }
    placed.push(item);
  }
  return layouts.map((l) => placed.find((p) => p.widgetId === l.widgetId)!);
}
export function compactLayouts(layouts: Layout[]): Layout[] {
  const placed: Layout[] = [];
  for (const item of [...layouts].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.widgetId.localeCompare(b.widgetId),
  )) {
    const candidate = { ...item, detached: true };
    outer: for (let y = 0; y <= 10000; y++) {
      for (let x = 0; x <= COLUMNS[item.breakpoint] - item.w; x++) {
        candidate.x = x;
        candidate.y = y;
        if (!placed.some((l) => overlaps(l, candidate))) break outer;
      }
    }
    placed.push(candidate);
  }
  return layouts.map((l) => placed.find((p) => p.widgetId === l.widgetId)!);
}
