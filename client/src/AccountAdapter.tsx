import { memo, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Gauge, Wallet, RefreshCw, ShieldCheck } from 'lucide-react';
import { accountTopic, type AccountStatus } from '../../packages/protocol/src';
import { core } from './core';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';

export const ACCOUNT_META = {
  glm: {
    name: 'GLM Coding Plan',
    subtitle: '中国区订阅用量',
    description: '查看智谱个人编程套餐的额度窗口与工具用量',
    icon: Gauge,
  },
  deepseek: {
    name: 'DeepSeek',
    subtitle: '账户余额',
    description: '查看可用余额、赠送余额和充值余额',
    icon: Wallet,
  },
} as const;
export type AccountID = keyof typeof ACCOUNT_META;
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
  status,
  online,
  compact = false,
  summary = false,
  details = true,
  windowLimit,
}: {
  status?: AccountStatus;
  online: boolean;
  compact?: boolean;
  summary?: boolean;
  details?: boolean;
  windowLimit?: number;
}) {
  const windows = [...(status?.windows || [])].sort(
    (a, b) => Number(a.id.startsWith('TIME_LIMIT')) - Number(b.id.startsWith('TIME_LIMIT')),
  );
  return (
    <>
      <div data-block="account" className={`account-values ${compact ? 'is-small' : ''}`}>
        {status?.id === 'deepseek' ? (
          status.balances.length ? (
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
              </div>
            ))
          ) : (
            <strong className="account-amount">—</strong>
          )
        ) : windows.length ? (
          windows.slice(0, compact || summary ? 2 : windowLimit).map((window) => (
            <div className="account-window" key={window.id}>
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
              {!compact && window.remainingPercent !== null ? (
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
          {status.id === 'deepseek'
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
            ? status.id === 'deepseek'
              ? status.available
                ? '余额可用于 API 调用'
                : '当前余额不足以调用 API'
              : '智谱中国区 · 个人编程套餐'
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

export function AccountAdapterCard({ id }: { id: AccountID }) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const status = state.telemetry[accountTopic(id)]?.value as AccountStatus | undefined;
  const [detail, setDetail] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const meta = ACCOUNT_META[id],
    owner = state.device?.role === 'owner';
  const change = async (payload?: {
    enabled?: boolean;
    apiKey?: string;
    clearCredential?: boolean;
  }) => {
    setBusy(true);
    setError('');
    try {
      await core.api(`/integrations/${id}${payload ? '' : '/refresh'}`, payload || {});
      setKey('');
    } catch (failure) {
      setError(connectionErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDetail(false);
    setKey('');
    setError('');
  };
  return (
    <article className="adapter-card panel" data-testid={`${id}-adapter`}>
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <meta.icon size={22} />
        </span>
        <span className="adapter-state">
          <span
            className={`status-light ${state.online && status?.state === 'ready' && !status.stale ? '' : 'offline'}`}
          />
          {accountState(status, state.online)}
        </span>
      </div>
      <h3>{meta.name}</h3>
      <span className="adapter-subtitle">{meta.subtitle}</span>
      <p>{meta.description}</p>
      <div className="adapter-fields">
        {id === 'deepseek' ? (
          <>
            <div>
              <span>可用余额</span>
              <span className="mono">
                {status?.balances[0]
                  ? amount(status.balances[0].total, status.balances[0].currency)
                  : '—'}
              </span>
            </div>
            <div>
              <span>查询状态</span>
              <span>{accountState(status, state.online)}</span>
            </div>
          </>
        ) : (
          [0, 1].map((index) => (
            <div key={index}>
              <span>{status?.windows[index]?.name || (index ? '其他窗口' : '主要窗口')}</span>
              <span className="mono">
                {status?.windows[index] ? percent(status.windows[index].remainingPercent) : '—'}
              </span>
            </div>
          ))
        )}
      </div>
      <Button
        className="secondary"
        aria-label={`查看${meta.name}用量与设置`}
        onClick={() => setDetail(true)}
      >
        用量与设置
        <ArrowRight size={16} />
      </Button>
      {detail ? (
        <Modal title={`${meta.name} · ${meta.subtitle}`} close={close} wide>
          <div className="account-detail-content">
            <AccountSummary status={status} online={state.online} />
          </div>
          <div className="adapter-boundary">
            <ShieldCheck size={18} />
            <p>
              API Key 加密保存在 Core 电脑，只查询账户信息，每 5 分钟同步一次，设备仅接收用量结果
            </p>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {owner ? (
            <form
              className="account-configuration"
              onSubmit={(event) => {
                event.preventDefault();
                void change({ enabled: true, ...(key.trim() ? { apiKey: key.trim() } : {}) });
              }}
            >
              <label>
                API Key
                <input
                  aria-label={`${meta.name} API Key`}
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={
                    status?.hasCredential ? '已保存，留空沿用当前 Key' : '粘贴平台生成的 API Key'
                  }
                  maxLength={4096}
                />
              </label>
              <div className="button-row">
                <Button
                  className="primary"
                  type="submit"
                  pending={busy}
                  disabled={!state.online || !status || (!key.trim() && !status.hasCredential)}
                >
                  保存并启用读取
                </Button>
                {status?.enabled ? (
                  <Button
                    className="secondary"
                    type="button"
                    disabled={busy || !state.online}
                    onClick={() => void change({ enabled: false })}
                  >
                    停用读取
                  </Button>
                ) : null}
                {status?.hasCredential ? (
                  <Button
                    className="secondary"
                    type="button"
                    disabled={busy || !state.online}
                    onClick={() => void change({ clearCredential: true })}
                  >
                    忘记凭据
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="subtle">只有 Owner 可以配置 API Key 或更改读取权限</p>
          )}
          <Button
            className="secondary"
            type="button"
            pending={busy || status?.refreshing}
            disabled={!state.online || !status?.enabled}
            onClick={() => void change()}
          >
            <RefreshCw size={18} />
            刷新用量
          </Button>
        </Modal>
      ) : null}
    </article>
  );
}
