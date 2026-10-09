import type { CoreState } from './core';

export function hostSummary(state: CoreState) {
  const numeric = (source: string) => {
    const item = Object.values(state.telemetry).find((item) => item.topic.endsWith('/' + source));
    if (
      state.online &&
      item?.ts &&
      Number.isFinite(Date.parse(item.ts)) &&
      Date.now() - Date.parse(item.ts) > 15000
    )
      return null;
    return item && typeof item.value === 'number' && Number.isFinite(item.value)
      ? item.value
      : null;
  };
  const issues: string[] = [];
  if (!state.online) issues.push(state.pairingRequired ? '需要重新配对' : '主机离线');
  const cpu = numeric('cpu.usage');
  const memory = numeric('memory.usage');
  const disk = numeric('disk.usage');
  if (state.online) {
    if (cpu !== null && cpu >= 90) issues.push('CPU 负载较高');
    if (memory !== null && memory >= 90) issues.push('内存使用较高');
    if (disk !== null && disk >= 90) issues.push('磁盘空间不足');
  }
  const software = Object.values(state.telemetry).flatMap((item) => {
    const data = item.value;
    if (!data || typeof data !== 'object' || !('state' in data) || !data.enabled) return [];
    const plugin = state.plugins.find((plugin) => item.topic.startsWith(plugin.id + '/'));
    const name = plugin?.name || item.topic.split('/').at(-1) || '插件';
    if (
      state.online &&
      !data.stale &&
      ['error', 'unauthorized', 'unavailable', 'expired'].includes(data.state)
    )
      issues.push(name + '需要检查');
    const description =
      'playback' in data && data.title
        ? `${data.playback === 'playing' ? '正在播放' : '已暂停'} · ${data.title}`
        : 'instances' in data
          ? `${data.instances.length} 个任务实例`
          : 'mode' in data
            ? data.mode
            : data.state === 'ready'
              ? '已接入'
              : data.stale
                ? '最近状态'
                : data.message;
    return [{ name, description, stale: data.stale }];
  });
  return {
    cpu,
    memory,
    disk,
    rx: numeric('network.rx'),
    tx: numeric('network.tx'),
    issues,
    software,
  };
}
export function rateLabel(value: number | null) {
  if (value === null) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let scale = 0;
  while (value >= 1024 && scale < units.length - 1) {
    value /= 1024;
    scale++;
  }
  return `${value.toFixed(scale ? 1 : 0)} ${units[scale]}`;
}
