import { memo } from 'react';
import { type AccountStatus } from '../../packages/protocol/src';
import { QuotaRing, BalanceComposition, UsagePreview, SegmentMeter } from './AdapterVisuals';

const percent = (value: number | null) => (value === null ? '—' : `${Number(value.toFixed(1))}%`);
const amount = (value: string, currency: string) => `${currency === 'CNY' ? '¥' : '$'}${value}`;
export function accountState(status: AccountStatus | undefined, online: boolean) {
  if (!online) return 'Core 离线';
  if (!status?.enabled) return '未启用';
  if (status.stale) return '数据过期';
  if (status.state === 'ready') return '已接入';
  if (status.state === 'connecting') return '正在连接';
  if (status.state === 'needs_credential') return '需要 API Key';
  return '暂不可用';
}
export function accountContents({
  valueMode,
  status,
  online,
  compact = false,
  summary = false,
  details = true,
  windowLimit,
  visual = false,
  style = 'auto',
  tiles = false,
}: {
  valueMode?: 'usage' | 'balance';
  status?: AccountStatus;
  online: boolean;
  compact?: boolean;
  summary?: boolean;
  details?: boolean;
  windowLimit?: number;
  visual?: boolean;
  style?: string;
  tiles?: boolean;
}) {
  const windows = [...(status?.windows || [])].sort(
    (a, b) => Number(a.id.startsWith('TIME_LIMIT')) - Number(b.id.startsWith('TIME_LIMIT')),
  );
  const balance =
    valueMode === 'balance' ||
    (valueMode === undefined && !windows.length && !!status?.balances.length);
  return (
    <>
      <div
        data-block="account"
        className={`account-values ${compact ? 'is-small' : ''} ${tiles && !compact ? 'account-tiles' : ''}`}
      >
        {balance ? (
          status?.balances.length ? (
            status.balances.map((balance) => (
              <div className="account-balance" key={balance.currency}>
                <span className="view-muted">
                  {compact
                    ? balance.currency
                    : `${balance.currency === 'CNY' ? '人民币' : '美元'}可用余额`}
                </span>
                <strong className="account-amount" title={amount(balance.total, balance.currency)}>
                  {amount(
                    compact && balance.total.length > 10
                      ? new Intl.NumberFormat('zh-CN', {
                          notation: 'compact',
                          maximumSignificantDigits: 4,
                        }).format(Number(balance.total))
                      : balance.total,
                    balance.currency,
                  )}
                </strong>
                {(visual || style === 'segments') && !compact ? (
                  <BalanceComposition
                    granted={balance.granted}
                    toppedUp={balance.toppedUp}
                    currency={balance.currency}
                    segmented={style === 'segments'}
                  />
                ) : null}
              </div>
            ))
          ) : (
            <strong className="account-amount">—</strong>
          )
        ) : windows.length ? (
          windows.slice(0, compact || summary ? 2 : windowLimit).map((window) => (
            <div
              className={`account-window ${visual && !compact ? 'with-ring' : ''}`}
              key={window.id}
            >
              {visual && !compact ? (
                <QuotaRing value={window.remainingPercent} label={`${window.name}剩余`} />
              ) : null}
              <div className="account-window-value">
                <span>
                  {compact || summary
                    ? window.name.replace('编程额度 · ', '').replace('MCP 工具额度 · ', '工具 · ')
                    : window.name}
                </span>
                <strong>
                  {percent(window.remainingPercent)}
                  <small>剩余</small>
                </strong>
              </div>
              {!compact && style === 'segments' ? (
                <SegmentMeter value={window.remainingPercent} label={`${window.name}剩余`} />
              ) : !compact && !visual && window.remainingPercent !== null ? (
                <progress
                  aria-label={`${window.name}剩余`}
                  max={100}
                  value={window.remainingPercent ?? undefined}
                />
              ) : null}
              {!compact && !summary ? (
                <span className="view-muted">
                  {window.resetsAt
                    ? `${new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`
                    : '服务未提供重置时间'}
                </span>
              ) : null}
            </div>
          ))
        ) : (
          <strong className="account-amount">—</strong>
        )}
      </div>
      {details && !compact && !summary && status?.state === 'ready' ? (
        <div data-block="details" className="account-details">
          {balance
            ? status.balances.map((balance) => (
                <div key={balance.currency}>
                  <span>{balance.currency} 赠送 / 充值</span>
                  <span>
                    {amount(balance.granted, balance.currency)} /{' '}
                    {amount(balance.toppedUp, balance.currency)}
                  </span>
                </div>
              ))
            : windows
                .filter((window) => window.current !== null && window.limit !== null)
                .map((window) => (
                  <div key={window.id}>
                    <span>{window.name}</span>
                    <span>
                      {window.current?.toLocaleString()} / {window.limit?.toLocaleString()}
                    </span>
                  </div>
                ))}
        </div>
      ) : null}
      {!compact ? (
        <p data-block="status" className="account-message view-muted">
          {status?.state === 'ready'
            ? balance
              ? status.available
                ? '余额可用于 API 调用'
                : '当前余额不足以调用 API'
              : status.message || '订阅用量'
            : status?.message || '配置并启用后显示账户信息'}
          {!online || status?.stale ? ' · 历史数据' : ''}
        </p>
      ) : null}
      {details && !compact && !summary && status?.updatedAt ? (
        <p data-block="updated" className="view-muted account-updated">
          最近同步{' '}
          {new Date(status.updatedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          {status.stale ? ' · 数据过期' : ''}
        </p>
      ) : null}
    </>
  );
}
export const AccountSummary = memo(accountContents);
