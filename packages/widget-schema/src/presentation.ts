import type { Breakpoint, Layout, Widget, WidgetProfile, WidgetBlock } from '../../protocol/src';
import { COLUMNS } from './index';
// Dimensions are grid units, shared by every declarative renderer.
export const SIZE_PRESETS = [
  { id: 'mini', label: '迷你', w: 2, h: 2 },
  { id: 'strip', label: '横条', w: 4, h: 2 },
  { id: 'standard', label: '标准', w: 4, h: 3 },
  { id: 'detail', label: '详情', w: 4, h: 4 },
  { id: 'wide', label: '宽幅', w: 6, h: 3 },
  { id: 'large', label: '大卡', w: 8, h: 4 },
] as const;
export const presetsFor = (breakpoint: Breakpoint) =>
  SIZE_PRESETS.filter((p) => p.w <= COLUMNS[breakpoint]);
export const PRESENTATIONS: Record<Widget['type'], readonly { id: string; label: string }[]> = {
  'metric-card': [
    { id: 'auto', label: '自动适配' },
    { id: 'value', label: '纯数值' },
    { id: 'trend', label: '数值与趋势' },
    { id: 'gauge', label: '用量进度' },
  ],
  'network-chart': [
    { id: 'auto', label: '自动适配' },
    { id: 'rates', label: '双向速率' },
    { id: 'trend', label: '合并趋势' },
    { id: 'split', label: '双向独立趋势' },
  ],
  'system-overview': [
    { id: 'auto', label: '自动适配' },
    { id: 'summary', label: '主机摘要' },
    { id: 'details', label: '硬件详情' },
  ],
  'codex-usage': [
    { id: 'auto', label: '自动适配' },
    { id: 'remaining', label: '剩余额度' },
    { id: 'windows', label: '额度与重置时间' },
  ],
  'account-usage': [
    { id: 'auto', label: '自动适配' },
    { id: 'summary', label: '额度与余额摘要' },
    { id: 'details', label: '完整账户信息' },
  ],
  'proxy-status': [
    { id: 'auto', label: '自动适配' },
    { id: 'summary', label: '模式与流量' },
    { id: 'details', label: '代理状态详情' },
  ],
};
export const sourcesFor = (type: Widget['type']) =>
  type === 'proxy-status'
    ? ['proxy.status']
    : type === 'codex-usage' || type === 'account-usage'
      ? ['account.usage']
      : type === 'system-overview'
        ? ['system.info']
        : type === 'network-chart'
          ? ['network.rx', 'network.tx']
          : ['cpu.usage', 'memory.usage', 'disk.usage', 'network.rx', 'network.tx'];
export const BLOCKS: Record<
  Widget['type'],
  readonly { id: string; label: string; required?: boolean }[]
> = {
  'metric-card': [
    { id: 'value', label: '数值', required: true },
    { id: 'gauge', label: '用量进度' },
    { id: 'trend', label: '趋势' },
    { id: 'stats', label: '区间统计' },
  ],
  'network-chart': [
    { id: 'rates', label: '双向速率', required: true },
    { id: 'trend', label: '趋势' },
    { id: 'stats', label: '峰值统计' },
  ],
  'system-overview': [
    { id: 'hostname', label: '主机名称', required: true },
    { id: 'memory', label: '核心与内存', required: true },
    { id: 'os', label: '操作系统' },
    { id: 'hardware', label: '硬件与运行时间' },
  ],
  'codex-usage': [
    { id: 'status', label: '账号状态' },
    { id: 'windows', label: '额度窗口', required: true },
    { id: 'credits', label: '重置卡' },
    { id: 'updated', label: '同步时间' },
  ],
  'account-usage': [
    { id: 'status', label: '账户状态' },
    { id: 'account', label: '额度与余额', required: true },
    { id: 'details', label: '金额与用量明细' },
    { id: 'updated', label: '同步时间' },
  ],
  'proxy-status': [
    { id: 'mode', label: '代理模式', required: true },
    { id: 'traffic', label: '收发流量', required: true },
    { id: 'node', label: '当前节点' },
    { id: 'status', label: '连接状态' },
    { id: 'updated', label: '同步时间' },
  ],
};
export const profileKey = (layout: Pick<Layout, 'breakpoint' | 'w' | 'h'>) =>
  `${layout.breakpoint}:${layout.w}x${layout.h}`;
export const defaultBlock = (order: number): WidgetBlock => ({
  order,
  column: 0,
  span: 12,
  align: 'start',
  visible: true,
});
export function widgetProfile(
  widget: Widget,
  layout: Pick<Layout, 'breakpoint' | 'w' | 'h'>,
): WidgetProfile {
  const saved = widget.sizeProfiles?.[profileKey(layout)];
  return {
    presentation: saved?.presentation || widget.presentation || 'auto',
    chartStyle: saved?.chartStyle || widget.chartStyle || 'line',
    blocks: saved?.blocks || {},
  };
}
export function orderedBlocks(widget: Widget, profile: WidgetProfile) {
  return BLOCKS[widget.type]
    .map((block, i) => ({ ...block, settings: profile.blocks[block.id] || defaultBlock(i) }))
    .sort((a, b) => a.settings.order - b.settings.order);
}
// Auto-place each row without overlap; narrow content gets a full-width lane.
export function placeBlocks(blocks: { id: string; settings: WidgetBlock }[], width: number) {
  const result: Record<string, { column: number; span: number; row: number }> = {};
  let row = 1,
    occupied = 0;
  for (const block of blocks.filter((b) => b.settings.visible)) {
    const minSpan = Math.min(12, Math.ceil((150 / Math.max(1, width)) * 12));
    const span = Math.max(minSpan, block.settings.span),
      column = Math.min(block.settings.column, 12 - span);
    const mask = ((1 << span) - 1) << column;
    if (occupied & mask) {
      row++;
      occupied = 0;
    }
    occupied |= mask;
    result[block.id] = { column, span, row };
  }
  return result;
}
