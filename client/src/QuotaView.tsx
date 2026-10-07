import type { CodexStatus, CodexWindow } from '../../packages/protocol/src';
import { QuotaRing, UsagePreview } from './AdapterVisuals';

export function windowLabel(window: CodexWindow): string {
  const duration = window.durationMinutes;
  if (duration === null) return window.id === 'primary' ? '主要窗口' : '次要窗口';
  if (duration < 60) return `${duration} 分钟`;
  if (duration % 10080 === 0) return `${duration / 10080} 周`;
  if (duration % 1440 === 0) return `${duration / 1440} 天`;
  if (duration % 60 === 0) return `${duration / 60} 小时`;
  return `${duration} 分钟`;
}
const percent = (value: number | null) => (value === null ? '—' : `${Number(value.toFixed(1))}%`);
const date = (seconds: number | null) =>
  seconds === null
    ? '重置时间未知'
    : new Date(seconds * 1000).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
export function statusLabel(status: CodexStatus | undefined, online: boolean): string {
  if (!online) return 'Core 离线';
  if (!status) return '等待读取';
  if (status.stale) return '数据过期';
  return (
    (
      {
        disabled: '未启用',
        connecting: '连接中',
        ready: '已接入',
        needs_login: '需要登录',
        not_found: '未找到 Codex',
        unsupported_auth: '登录方式不支持',
        incompatible: '需要更新',
        unavailable: '暂不可用',
      } as Record<string, string>
    )[status.state] || '状态未知'
  );
}
function QuotaWindow({ window }: { window: CodexWindow }) {
  return (
    <div className="codex-window with-ring">
      <QuotaRing value={window.remainingPercent} label={`${windowLabel(window)}剩余`} />
      <div className="codex-window-heading">
        <span>{windowLabel(window)}窗口</span>
        <strong>剩余 {percent(window.remainingPercent)}</strong>
      </div>
      <div
        className="codex-progress"
        role="progressbar"
        aria-label={`${windowLabel(window)}窗口已用额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent ?? undefined}
        aria-valuetext={
          window.usedPercent === null ? '额度未知' : `已用 ${percent(window.usedPercent)}`
        }
      >
        <span style={{ width: `${window.usedPercent ?? 0}%` }} />
      </div>
      <div className="codex-window-meta">
        <span>已用 {percent(window.usedPercent)}</span>
        <span>
          {date(window.resetsAt)}
          {window.resetsAt === null ? '' : ' 重置'}
        </span>
      </div>
    </div>
  );
}
export function CodexUsage({
  status,
  online,
  compact = false,
}: {
  status?: CodexStatus;
  online: boolean;
  compact?: boolean;
}) {
  const buckets = compact
    ? status?.buckets.filter((b) => b.id === 'codex').slice(0, 1)
    : status?.buckets;
  const selected = compact && !buckets?.length ? status?.buckets.slice(0, 1) : buckets;
  const timestamp = status?.updatedAt
    ? new Date(status.updatedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return (
    <div className={`codex-usage ${compact ? 'compact' : ''}`}>
      <div className="codex-summary">
        <span className="badge">{status?.planType ? status.planType.toUpperCase() : 'CODEX'}</span>
        <span className="subtle">{statusLabel(status, online)}</span>
      </div>
      {selected?.map((bucket) => (
        <section
          className="codex-bucket"
          key={bucket.id}
          aria-label={`${bucket.name || bucket.id}额度`}
        >
          {!compact ? (
            <h3>{bucket.name || (bucket.id === 'codex' ? 'Codex' : bucket.id)}</h3>
          ) : null}
          {bucket.windows.length ? (
            bucket.windows.map((window) => <QuotaWindow window={window} key={window.id} />)
          ) : (
            <p className="subtle">未提供额度窗口</p>
          )}
        </section>
      ))}
      {!selected?.length ? (
        <p className="codex-empty">
          {!online
            ? '连接 Core 后更新额度'
            : status?.state === 'ready'
              ? '当前账号未提供额度窗口'
              : status?.message || '等待 Core 提供适配状态'}
        </p>
      ) : null}
      <div className="codex-credit-row">
        <span>重置卡</span>
        <strong>
          {status?.resetCredits?.availableCount ?? '—'}
          <span className="subtle"> 张</span>
        </strong>
      </div>
      {!compact && status?.resetCredits?.expiresAt ? (
        <p className="subtle">最早到期：{date(status.resetCredits.expiresAt)}</p>
      ) : null}
      <p className="codex-updated">
        {timestamp
          ? `最近同步 ${timestamp}${!online || status?.stale ? ' · 历史数据' : ''}`
          : '尚未成功同步'}
        {!compact ? ' · 每分钟更新' : ''}
      </p>
      {!compact && status && status.state !== 'ready' && status.updatedAt ? (
        <p role="status" className="subtle">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
