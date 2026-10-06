import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, Code2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CodexStatus, CodexWindow } from '../../packages/protocol/src';
import { CODEX_TOPIC } from '../../packages/protocol/src';
import { core } from './core';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';

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
    <div className="codex-window">
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
export function CodexAdapterCard() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const status = state.telemetry[CODEX_TOPIC]?.value as CodexStatus | undefined;
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = state.device?.role === 'owner';
  const invoke = async (enabled?: boolean) => {
    setBusy(true);
    setError('');
    try {
      await core.api<CodexStatus>(
        enabled === undefined ? '/integrations/codex/refresh' : '/integrations/codex',
        enabled === undefined ? {} : { enabled },
      );
    } catch (e) {
      setError(connectionErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const main = status?.buckets.find((bucket) => bucket.id === 'codex') || status?.buckets[0];
  return (
    <article className="adapter-card panel" data-testid="codex-adapter">
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <Code2 size={22} />
        </span>
        <span className="adapter-state">
          <span
            className={`status-light ${state.online && status?.state === 'ready' && !status.stale ? '' : 'offline'}`}
          />
          {statusLabel(status, state.online)}
        </span>
      </div>
      <h3>Codex</h3>
      <span className="adapter-subtitle">订阅额度</span>
      <p>复用电脑上的 Codex 登录，查看额度窗口和重置卡</p>
      <div className="adapter-fields">
        {[0, 1].map((index) => (
          <div key={index}>
            <span>
              {main?.windows[index]
                ? `${windowLabel(main.windows[index])}剩余`
                : index === 0
                  ? '主要窗口剩余'
                  : '次要窗口剩余'}
            </span>
            <span className="mono">
              {main?.windows[index] ? percent(main.windows[index].remainingPercent) : '—'}
            </span>
          </div>
        ))}
      </div>
      <Button
        className="secondary"
        aria-label="查看Codex额度与设置"
        onClick={() => setDetail(true)}
      >
        额度与设置
        <ArrowRight size={16} />
      </Button>
      {detail ? (
        <Modal title="Codex · 订阅额度" close={() => setDetail(false)}>
          <CodexUsage status={status} online={state.online} />
          <div className="adapter-boundary">
            <ShieldCheck size={18} />
            <p>
              读取 Core 电脑上已登录的 ChatGPT 订阅，凭据由 Codex
              管理，平板只接收额度；不执行任务或消耗重置卡，任务运行状态尚未接入
            </p>
          </div>
          {!owner ? <p className="subtle">只有电脑上的 Owner 可以启用或停用适配</p> : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row codex-actions">
            {status?.enabled ? (
              <>
                <Button
                  className="secondary"
                  pending={busy || status.refreshing}
                  disabled={!state.online}
                  onClick={() => void invoke()}
                >
                  <RefreshCw size={16} />
                  刷新额度
                </Button>
                <Button
                  className="secondary"
                  disabled={!owner || !state.online || busy}
                  onClick={() => void invoke(false)}
                >
                  停用读取
                </Button>
              </>
            ) : (
              <Button
                className="primary"
                pending={busy}
                disabled={!owner || !state.online || !status}
                onClick={() => void invoke(true)}
              >
                授权并启用额度读取
              </Button>
            )}
          </div>
          <p className="subtle">
            手动刷新至少间隔 15 秒，可在「添加组件」中将 Codex 额度放入工作空间
          </p>
        </Modal>
      ) : null}
    </article>
  );
}
