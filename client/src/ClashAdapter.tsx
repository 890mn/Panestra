import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { CLASH_TOPIC, type ClashStatus } from '../../packages/protocol/src';
import { core } from './core';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';
import { TrafficPlot, SegmentMeter } from './AdapterVisuals';

export const modeName = (mode: string) =>
  ({ rule: '规则', global: '全局', direct: '直连' })[mode] || '—';
const rate = (value: number | null | undefined) =>
  value == null
    ? '—'
    : value >= 1024 * 1024
      ? `${(value / 1024 / 1024).toFixed(1)} MB/s`
      : `${(value / 1024).toFixed(1)} KB/s`;
export function clashState(status: ClashStatus | undefined, online: boolean) {
  if (!online) return 'Core 离线';
  if (!status?.enabled) return '未启用';
  if (status.stale) return '数据过期';
  if (status.state === 'ready') return '已接入';
  if (status.state === 'connecting') return '正在连接';
  if (status.state === 'not_found') return '未找到控制器';
  if (status.state === 'needs_credential') return '凭据失效';
  return '暂不可用';
}
export function clashContents({
  status,
  online,
  compact = false,
  summary = false,
  showNode = true,
  height = 600,
  trend = false,
  rxHistory = [],
  txHistory = [],
  area = false,
  mode = 'auto',
}: {
  status?: ClashStatus;
  online: boolean;
  compact?: boolean;
  summary?: boolean;
  showNode?: boolean;
  height?: number;
  trend?: boolean;
  rxHistory?: number[];
  txHistory?: number[];
  area?: boolean;
  mode?: string;
}) {
  const group =
    status?.groups.find((g) => g.name === 'GLOBAL') ||
    status?.groups.find((g) => g.selectable) ||
    status?.groups[0];
  return (
    <>
      <div data-block="mode" className={`clash-mode ${compact ? 'is-small' : ''}`}>
        <span className="view-muted">代理模式</span>
        <strong>{modeName(status?.mode || '')}</strong>
      </div>
      <div data-block="traffic" className="clash-traffic">
        <div className={`clash-rates ${compact ? 'is-small' : ''}`}>
          <div>
            <span className="view-muted">接收</span>
            <strong>{rate(status?.download)}</strong>
          </div>
          <div>
            <span className="view-muted">发送</span>
            <strong>{rate(status?.upload)}</strong>
          </div>
        </div>
        {mode === 'meters' && !compact && height >= 210 ? (
          <div className="traffic-meters">
            {[
              ['接收', status?.download, false],
              ['发送', status?.upload, true],
            ].map(([label, value, secondary]) => (
              <SegmentMeter
                key={String(label)}
                value={
                  typeof value !== 'number'
                    ? null
                    : (value /
                        Math.max(
                          1,
                          ...rxHistory,
                          ...txHistory,
                          status?.download ?? 0,
                          status?.upload ?? 0,
                        )) *
                      100
                }
                label={`${label}相对最近峰值`}
                secondary={!!secondary}
              />
            ))}
            <span className="view-muted">刻度相对最近采样峰值</span>
          </div>
        ) : trend && !compact && mode !== 'route' ? (
          <div className="clash-trend">
            <TrafficPlot receive={rxHistory} send={txHistory} area={area} />
            <div className="view-chart-caption">
              <span>
                <i />
                接收 <i className="secondary" />
                发送
              </span>
              <span>最近 {Math.min(30, rxHistory.length)} 次采样</span>
            </div>
          </div>
        ) : null}
      </div>
      {!compact && showNode && (!trend || height >= 320 || mode === 'route') ? (
        <div
          data-block="node"
          className={`clash-current-node ${mode === 'route' ? 'clash-route' : ''}`}
        >
          {mode === 'route' ? (
            <span className="route-origin">
              <span className="status-light" />
              本机 Core <ArrowRight size={14} />
            </span>
          ) : null}
          <span className="view-muted">{group?.name || '策略组'}</span>
          <span>{group?.current || '—'}</span>
        </div>
      ) : null}
      {!compact && !summary ? (
        <p data-block="status" className="view-muted account-message">
          {status?.message || '启用读取后显示本机代理状态'}
          {!online || status?.stale ? ' · 历史数据' : ''}
        </p>
      ) : null}
      {!compact && !summary && status?.updatedAt ? (
        <p data-block="updated" className="view-muted account-updated">
          最近同步{' '}
          {new Date(status.updatedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          {status.version ? ` · Mihomo ${status.version}` : ''}
        </p>
      ) : null}
    </>
  );
}
export function ClashAdapterCard() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const status = state.telemetry[CLASH_TOPIC]?.value as ClashStatus | undefined;
  const receive = state.history[`${CLASH_TOPIC}/download`] || [],
    send = state.history[`${CLASH_TOPIC}/upload`] || [];
  const [detail, setDetail] = useState(false),
    [secret, setSecret] = useState(''),
    [address, setAddress] = useState(''),
    [automatic, setAutomatic] = useState(true),
    [allowControl, setAllowControl] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = state.device?.role === 'owner';
  const canControl =
    state.online &&
    status?.enabled &&
    status.state === 'ready' &&
    !status.stale &&
    status.allowControl &&
    ['owner', 'operator'].includes(state.device?.role || '');
  const open = () => {
    setAutomatic(status?.autoDetect ?? true);
    setAddress(status?.controller || 'http://127.0.0.1:9097');
    setAllowControl(status?.allowControl ?? false);
    setDetail(true);
  };
  const close = () => {
    setDetail(false);
    setSecret('');
    setError('');
  };
  const request = async (path: string, payload: unknown) => {
    setBusy(true);
    setError('');
    try {
      await core.api(`/integrations/clash${path}`, payload);
      setSecret('');
    } catch (failure) {
      setError(connectionErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="adapter-card panel" data-testid="clash-adapter">
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <Network size={22} />
        </span>
        <span className="adapter-state">
          <span
            className={`status-light ${state.online && status?.state === 'ready' && !status.stale ? '' : 'offline'}`}
          />
          {clashState(status, state.online)}
        </span>
      </div>
      <h3>Clash Verge</h3>
      <span className="adapter-subtitle">代理控制</span>
      <p>查看代理模式与流量，切换模式和策略组节点</p>
      <div className="adapter-visual adapter-traffic">
        <TrafficPlot receive={receive} send={send} area />
        <div className="view-chart-caption">
          <span>接收 {rate(status?.download)}</span>
          <span>发送 {rate(status?.upload)}</span>
        </div>
      </div>
      <div className="adapter-fields">
        <div>
          <span>代理模式</span>
          <span>{modeName(status?.mode || '')}</span>
        </div>
        <div>
          <span>控制权限</span>
          <span>{status?.allowControl ? '已授权' : '只读'}</span>
        </div>
      </div>
      <Button className="secondary" aria-label="查看Clash状态与设置" onClick={open}>
        状态与设置
        <ArrowRight size={16} />
      </Button>
      {detail ? (
        <Modal title="Clash Verge · 代理控制" close={close} wide>
          <div className="account-detail-content">
            {clashContents({
              status,
              online: state.online,
              trend: true,
              rxHistory: receive,
              txHistory: send,
              area: true,
            })}
          </div>
          <div className="button-row clash-mode-controls" aria-label="代理模式">
            {(['rule', 'global', 'direct'] as const).map((mode) => (
              <Button
                key={mode}
                className="status-button"
                selected={status?.mode === mode}
                disabled={!canControl || busy}
                onClick={() => {
                  if (status?.mode !== mode) void request('/actions', { action: 'mode', mode });
                }}
              >
                {modeName(mode)}
              </Button>
            ))}
          </div>
          <div className="clash-groups">
            {status?.groups.map((group) => (
              <label key={group.name}>
                <span>
                  {group.name}
                  {!group.selectable ? ' · 自动选择' : ''}
                </span>
                <select
                  aria-label={`${group.name}节点`}
                  value={group.current}
                  disabled={!canControl || busy || !group.selectable}
                  onChange={(event) =>
                    void request('/actions', {
                      action: 'node',
                      group: group.name,
                      node: event.target.value,
                    })
                  }
                >
                  {!group.options.includes(group.current) ? (
                    <option value={group.current}>{group.current || '未选择'}</option>
                  ) : null}
                  {group.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="adapter-boundary">
            <ShieldCheck size={18} />
            <p>只连接 Core 电脑上的 Mihomo 控制器，系统代理和 TUN 由 Clash Verge 管理</p>
          </div>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          {owner ? (
            <form
              className="account-configuration"
              onSubmit={(event) => {
                event.preventDefault();
                void request('', {
                  enabled: true,
                  autoDetect: automatic,
                  allowControl,
                  ...(!automatic ? { controller: address, ...(secret ? { secret } : {}) } : {}),
                });
              }}
            >
              <label className="permission-row">
                <span>自动发现本机 Clash Verge</span>
                <input
                  type="checkbox"
                  checked={automatic}
                  onChange={(event) => setAutomatic(event.target.checked)}
                />
              </label>
              {!automatic ? (
                <>
                  <label>
                    控制器地址
                    <input
                      type="text"
                      aria-label="Mihomo 控制器地址"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      placeholder="http://127.0.0.1:9097"
                      required
                    />
                  </label>
                  <label>
                    Secret
                    <input
                      type="password"
                      aria-label="Mihomo Secret"
                      autoComplete="new-password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={
                        status?.hasCredential ? '留空沿用已保存 Secret' : '没有设置 Secret 时可留空'
                      }
                      maxLength={4096}
                    />
                  </label>
                </>
              ) : null}
              <label className="permission-row">
                <span>允许切换模式与节点</span>
                <input
                  type="checkbox"
                  checked={allowControl}
                  onChange={(event) => setAllowControl(event.target.checked)}
                />
              </label>
              <div className="button-row">
                <Button type="submit" className="primary" pending={busy} disabled={!state.online}>
                  保存并启用读取
                </Button>
                {status?.enabled ? (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('', { enabled: false, allowControl: false })}
                  >
                    停用读取
                  </Button>
                ) : null}
                {!automatic && status?.hasCredential ? (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('', { clearCredential: true })}
                  >
                    忘记凭据
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="subtle">只有 Owner 可以配置控制器或授权控制权限</p>
          )}
          <Button
            type="button"
            className="secondary"
            pending={busy || status?.refreshing}
            disabled={!state.online || !status?.enabled}
            onClick={() => void request('/refresh', {})}
          >
            <RefreshCw size={18} />
            刷新状态
          </Button>
        </Modal>
      ) : null}
    </article>
  );
}
