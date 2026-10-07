import { useLayoutEffect, useRef, useState } from 'react';
import type {
  AccountStatus,
  ClashStatus,
  MediaStatus,
  AlasStatus,
  CodexStatus,
  SystemInfo,
  Widget,
  WidgetProfile,
} from '../../packages/protocol/src';
import { accountContents } from './AccountAdapter';
import { clashContents } from './ClashAdapter';
import { musicContents } from './MusicAdapter';
import { alasContents } from './AlasAdapter';
import { ContentLayout, type ContentEditor } from './ContentLayout';
import { windowLabel, CodexUsage, statusLabel } from './CodexAdapter';
import { Sparkline, QuotaRing } from './AdapterVisuals';

export type ViewProps = {
  widget: Widget;
  data?: number | SystemInfo | CodexStatus | AccountStatus | ClashStatus | MediaStatus | AlasStatus;
  download?: number;
  upload?: number;
  history: number[];
  rxHistory: number[];
  txHistory: number[];
  online: boolean;
  editing?: boolean;
};
const percent = (value: number | null) => (value === null ? '—' : `${Number(value.toFixed(1))}%`);
const reset = (seconds: number | null) =>
  seconds === null
    ? '重置时间未知'
    : `${new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`;
const rate = (value: number | undefined) =>
  value === undefined
    ? ['—', 'KB/s']
    : value >= 1024
      ? [Number((value / 1024).toFixed(1)).toString(), 'MB/s']
      : [Number(value.toFixed(1)).toString(), 'KB/s'];
export function WidgetView(
  props: ViewProps & { expanded?: boolean; profile?: WidgetProfile; contentEditor?: ContentEditor },
) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { widget, data, history, rxHistory, txHistory, online, expanded } = props;
  const mode = props.profile?.presentation || widget.presentation || 'auto';
  const area = (props.profile?.chartStyle || widget.chartStyle) === 'area';
  const short = !expanded && size.h < 120;
  const narrow = !expanded && size.w < 240;
  const roomy = !!expanded || size.h >= 240;
  const metric = typeof data === 'number' ? data : undefined;
  const system = typeof data === 'object' && 'hostname' in data ? data : undefined;
  const codex = typeof data === 'object' && 'buckets' in data ? data : undefined;
  const main = codex?.buckets.find((b) => b.id === 'codex') || codex?.buckets[0];
  const chartAllowed = !!expanded || size.h >= 145;
  const networkTrend = chartAllowed && mode !== 'rates';
  const accountWidth = size.w * ((props.profile?.blocks.account?.span || 12) / 12);
  const musicPlayerLayout =
    widget.type === 'media-control' &&
    !Object.keys(props.profile?.blocks || {}).length &&
    mode !== 'track' &&
    size.w >= 240 &&
    size.h >= 135;
  const split = networkTrend && mode === 'split' && size.h >= 225;
  const metricText = widget.source.startsWith('network.')
    ? rate(metric)
    : [metric === undefined ? '—' : Number(metric.toFixed(1)).toString(), widget.unit || '%'];
  const metricTrend = chartAllowed && ['auto', 'trend'].includes(mode);
  const contents = (
    <>
      {widget.type === 'task-status'
        ? alasContents({
            status: typeof data === 'object' && 'instances' in data ? data : undefined,
            online,
            compact: short,
            height: size.h,
            mode,
            expanded,
          })
        : null}
      {widget.type === 'media-control'
        ? musicContents({
            status: typeof data === 'object' && 'playback' in data ? data : undefined,
            online,
            compact: short,
            small: narrow,
            height: size.h,
            width: size.w * ((props.profile?.blocks.track?.span || 12) / 12),
            mode,
            expanded,
            editing: !!props.editing || !!props.contentEditor,
            inlineControls: !!expanded || musicPlayerLayout,
          })
        : null}
      {widget.type === 'proxy-status'
        ? clashContents({
            status: typeof data === 'object' && 'groups' in data ? data : undefined,
            online,
            compact: short,
            summary: !expanded && (mode === 'summary' || size.h < 350),
            showNode: !!expanded || size.h >= 200,
            height: size.h,
            trend: !!expanded || (mode !== 'summary' && size.h >= 210),
            rxHistory,
            txHistory,
            area,
          })
        : null}
      {widget.type === 'account-usage'
        ? accountContents({
            status: typeof data === 'object' && 'balances' in data ? data : undefined,
            online,
            compact: short,
            summary: !expanded && (mode === 'summary' || size.h < 350 || accountWidth < 240),
            details: !!expanded || size.h >= 520,
            windowLimit: expanded ? undefined : Math.max(2, Math.floor((size.h - 120) / 100)),
            visual:
              !!expanded ||
              (size.h >= 210 && accountWidth >= 190 && ['auto', 'visual'].includes(mode)),
          })
        : null}
      {widget.type === 'metric-card' ? (
        <>
          <div data-block="value" className="view-metric">
            <strong className="metric-value">
              {metricText[0]}
              <span>{metricText[1]}</span>
            </strong>
            {!short ? (
              <span className="view-muted">
                {!online
                  ? 'Core 离线'
                  : metric === undefined
                    ? '等待数据'
                    : metric >= 85
                      ? '负载较高'
                      : '运行正常'}
              </span>
            ) : null}
          </div>
          {mode === 'gauge' && size.h >= 50 ? (
            <div
              data-block="gauge"
              className="view-gauge"
              role="progressbar"
              aria-label="当前用量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={metric === undefined ? undefined : Math.min(100, Math.max(0, metric))}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, metric || 0))}%` }} />
            </div>
          ) : null}
          {metricTrend ? (
            <div data-block="trend" className="view-trend">
              <Sparkline values={history} area={area} />
              <div className="view-chart-caption">
                <span>最近 60 秒</span>
                <span>现在</span>
              </div>
            </div>
          ) : null}
          {roomy && mode !== 'value' ? (
            <div data-block="stats" className="view-stats">
              {[
                ['最低', history.length ? Math.min(...history) : undefined],
                [
                  '平均',
                  history.length ? history.reduce((a, b) => a + b, 0) / history.length : undefined,
                ],
                ['最高', history.length ? Math.max(...history) : undefined],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>
                    {typeof value === 'number'
                      ? `${Number(value.toFixed(1))}${widget.unit || '%'}`
                      : '—'}
                  </strong>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {widget.type === 'network-chart' ? (
        <>
          <div data-block="rates" className="view-rates">
            {[
              { label: '接收', value: props.download, secondary: false },
              { label: '发送', value: props.upload, secondary: true },
            ].map((item) => {
              const [value, unit] = rate(item.value);
              return (
                <div key={item.label}>
                  <span className={item.secondary ? '' : 'rate-receive'}>{item.label}</span>
                  <strong>
                    {value}
                    <small>{unit}</small>
                  </strong>
                </div>
              );
            })}
          </div>
          {networkTrend ? (
            <div data-block="trend" className={`view-trend ${split ? 'view-split' : ''}`}>
              <div>
                <Sparkline
                  values={rxHistory}
                  area={area}
                  scaleMax={split ? undefined : Math.max(10, ...rxHistory, ...txHistory)}
                />
                {split ? <span className="view-muted">接收</span> : null}
              </div>
              <div>
                <Sparkline
                  values={txHistory}
                  area={area}
                  secondary
                  scaleMax={split ? undefined : Math.max(10, ...rxHistory, ...txHistory)}
                />
                {split ? <span className="view-muted">发送</span> : null}
              </div>
              <div className="view-chart-caption">
                <span>
                  {narrow ? '60 秒' : '最近 60 秒'} · <i />
                  {narrow ? '收' : '接收'} <i className="secondary" />
                  {narrow ? '发' : '发送'}
                </span>
                <span>现在</span>
              </div>
            </div>
          ) : null}
          {roomy && mode !== 'rates' ? (
            <div data-block="stats" className="view-stats">
              <div>
                <span>接收峰值 / 60 秒</span>
                <strong>
                  {rate(rxHistory.length ? Math.max(...rxHistory) : undefined).join(' ')}
                </strong>
              </div>
              <div>
                <span>发送峰值 / 60 秒</span>
                <strong>
                  {rate(txHistory.length ? Math.max(...txHistory) : undefined).join(' ')}
                </strong>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {widget.type === 'system-overview' ? (
        <>
          <strong data-block="hostname" className="view-hostname" title={system?.hostname}>
            {system?.hostname || 'Panestra Core'}
          </strong>
          <span data-block="memory" className="view-muted">
            {system
              ? `${system.cores} 核 · ${Number(system.memoryGB.toFixed(1))} GB`
              : '等待系统信息'}
          </span>
          {!short && !narrow ? (
            <span data-block="os" className="view-muted view-os">
              {system?.os || '—'}
            </span>
          ) : null}
          {!short && mode !== 'summary' ? (
            <dl data-block="hardware" className="view-system-details">
              {expanded || (!narrow && size.h >= 190) || size.h >= 320 ? (
                <div>
                  <dt>处理器</dt>
                  <dd>{system?.cpu || '—'}</dd>
                </div>
              ) : null}
              <div>
                <dt>运行时间</dt>
                <dd>
                  {system
                    ? `${Math.floor(system.uptime / 3600)} 小时 ${Math.floor((system.uptime % 3600) / 60)} 分钟`
                    : '—'}
                </dd>
              </div>
            </dl>
          ) : null}
        </>
      ) : null}
      {widget.type === 'codex-usage' ? (
        expanded ? (
          <CodexUsage status={codex} online={online} />
        ) : (
          <>
            {!short ? (
              <div data-block="status" className="view-quota-status">
                <span>{codex?.planType?.toUpperCase() || 'CODEX'}</span>
                <span>{statusLabel(codex, online)}</span>
              </div>
            ) : null}
            {main?.windows.length ? (
              <div data-block="windows" className="view-quota-windows">
                {main.windows.slice(0, 2).map((window) => (
                  <div
                    className={`view-quota-window ${(mode === 'rings' || mode === 'auto') && size.h >= 190 && size.w >= 210 ? 'with-ring' : ''}`}
                    key={window.id}
                  >
                    {(mode === 'rings' || mode === 'auto') && size.h >= 190 && size.w >= 210 ? (
                      <QuotaRing
                        value={window.remainingPercent}
                        label={`${windowLabel(window)}剩余`}
                      />
                    ) : null}
                    <div>
                      <span>{windowLabel(window)}</span>
                      <strong>
                        {percent(window.remainingPercent)}
                        <small>剩余</small>
                      </strong>
                    </div>
                    {!short && mode !== 'remaining' ? (
                      <>
                        <div className="view-gauge quota-linear">
                          <span style={{ width: `${window.remainingPercent ?? 0}%` }} />
                        </div>
                        {roomy || (size.h >= 190 && !narrow) ? (
                          <span className="view-muted">{reset(window.resetsAt)}</span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p data-block="windows" className="view-quota-empty">
                {!online
                  ? '连接 Core 后更新'
                  : codex?.state === 'ready'
                    ? '未提供额度窗口'
                    : codex?.state === 'disabled'
                      ? '在插件页启用读取'
                      : statusLabel(codex, online)}
              </p>
            )}
            {!short ? (
              <div data-block="credits" className="view-reset-credits">
                <span>重置卡</span>
                <strong>{codex?.resetCredits?.availableCount ?? '—'} 张</strong>
              </div>
            ) : null}
            {roomy ? (
              <span data-block="updated" className="view-muted">
                {codex?.updatedAt
                  ? `最近同步 ${new Date(codex.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${!online || codex.stale ? ' · 历史数据' : ''}`
                  : '尚未成功同步'}
              </span>
            ) : null}
          </>
        )
      ) : null}
    </>
  );
  const profile = props.profile || {
    presentation: mode,
    chartStyle: area ? 'area' : 'line',
    blocks: {},
  };
  return (
    <div
      ref={ref}
      className={`widget-view ${short ? 'view-short' : ''} ${narrow ? 'view-narrow' : ''} ${roomy ? 'view-roomy' : ''}`}
      data-presentation={mode}
      data-type={widget.type}
    >
      {!expanded &&
      (widget.type === 'media-control' ||
        props.contentEditor ||
        Object.keys(profile.blocks).length) ? (
        <ContentLayout
          widget={widget}
          profile={profile}
          width={size.w}
          height={size.h}
          editor={props.contentEditor}
          playerLayout={musicPlayerLayout}
        >
          {contents}
        </ContentLayout>
      ) : expanded && widget.type === 'media-control' && mode !== 'track' ? (
        <div className="music-detail-content">{contents}</div>
      ) : (
        contents
      )}
    </div>
  );
}
