import { type AlasStatus } from '../../packages/protocol/src';

export const alasState = (status: AlasStatus | undefined, online: boolean) =>
  !online
    ? 'Core 离线'
    : !status?.enabled
      ? '未启用'
      : status.stale
        ? '数据过期'
        : status.state === 'ready'
          ? '已接入'
          : status.state === 'connecting'
            ? '正在读取'
            : status.state === 'bridge_required'
              ? '等待桥接启动'
              : status.state === 'instance_missing'
                ? '实例未载入'
                : '暂不可用';
const instanceState = (state?: string) =>
  ({ running: '运行中', stopped: '已停止', error: '异常停止', updating: '更新中' })[state || ''] ||
  '未知';
const scheduledTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function alasContents({
  status,
  online,
  compact = false,
  height = 600,
  width = 800,
  mode = 'auto',
  expanded = false,
}: {
  status?: AlasStatus;
  online: boolean;
  compact?: boolean;
  height?: number;
  width?: number;
  mode?: string;
  expanded?: boolean;
}) {
  const instance = status?.instances.find((item) => item.name === status.instance);
  const valid = status?.enabled && status.state === 'ready' && !status.stale && online;
  const board = mode === 'board' && height >= 170 && (width >= 240 || height >= 300);
  return (
    <>
      <div
        data-block="status"
        className={`alas-status ${compact ? 'is-small' : ''} ${board ? 'alas-board' : ''}`}
      >
        <strong>
          <i
            className={`alas-state-indicator ${valid && instance?.state === 'running' ? 'active' : ''}`}
          />
          {valid ? instanceState(instance?.state) : alasState(status, online)}
        </strong>
        {!compact ? (
          <span className="view-muted">
            {status?.instance || 'alas'}
            {!valid && instance ? ' · 历史数据' : ''}
          </span>
        ) : null}
        {board ? (
          <div className="alas-queue-count">
            <span className="view-muted">调度任务</span>
            <strong>
              {instance?.tasks.length ?? '—'}
              <small> 项</small>
            </strong>
          </div>
        ) : null}
      </div>
      {!compact && (height >= 130 || expanded) ? (
        <div data-block="current" className="alas-task">
          <span className="view-muted">{instance?.waitingTask ? '等待执行' : '当前任务'}</span>
          <strong title={instance?.currentTask || instance?.waitingTask || ''}>
            {instance?.currentTask || instance?.waitingTask || '—'}
          </strong>
        </div>
      ) : null}
      {(height >= 210 || expanded) && instance?.tasks[0] ? (
        <div data-block="next" className="alas-task alas-next-task">
          <span className="view-muted">下次执行</span>
          <strong title={instance.tasks[0].name}>{instance.tasks[0].name}</strong>
          <span className="view-muted">{scheduledTime(instance.tasks[0].nextRun)}</span>
        </div>
      ) : null}
      {(height >= 360 || expanded) && (mode !== 'summary' || expanded) && instance?.tasks.length ? (
        <div
          data-block="queue"
          className={`alas-queue ${mode === 'timeline' || mode === 'auto' || expanded ? 'is-timeline' : ''}`}
        >
          {instance.tasks
            .slice(0, expanded ? 20 : Math.max(1, Math.floor((height - 280) / 44)))
            .map((task, i) => (
              <div key={`${task.name}-${i}`}>
                <span title={task.name}>{task.name}</span>
                <time>{scheduledTime(task.nextRun)}</time>
              </div>
            ))}
        </div>
      ) : null}
      {(height >= 460 || expanded) && status?.updatedAt ? (
        <p data-block="updated" className="view-muted account-updated">
          最近同步{' '}
          {new Date(status.updatedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      ) : null}
    </>
  );
}
