import { ArrowRight, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { type ClashStatus } from '../../packages/protocol/src';
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
