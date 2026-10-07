import { Disc3 } from 'lucide-react';

export function QuotaRing({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <svg
      className="quota-ring"
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${label} ${percent === null ? '未知' : `${Number(percent.toFixed(1))}%`}`}
    >
      <circle className="quota-ring-track" cx="24" cy="24" r="19" />
      {percent !== null ? (
        <circle
          className="quota-ring-value"
          cx="24"
          cy="24"
          r="19"
          pathLength="100"
          strokeDasharray={`${percent} ${100 - percent}`}
          transform="rotate(-90 24 24)"
        />
      ) : null}
      <circle className="quota-ring-center" cx="24" cy="24" r="3" />
    </svg>
  );
}

export function BalanceComposition({
  granted,
  toppedUp,
  currency,
}: {
  granted: string;
  toppedUp: string;
  currency: string;
}) {
  const gift = Number(granted),
    paid = Number(toppedUp);
  const known =
    Number.isFinite(gift) && Number.isFinite(paid) && gift >= 0 && paid >= 0 && gift + paid > 0;
  if (!known) return null;
  return (
    <div
      className="balance-composition"
      aria-label={`${currency} 赠送 ${granted}，充值 ${toppedUp}`}
    >
      <div className="balance-segments" aria-hidden="true">
        <span style={{ width: `${(gift / (gift + paid)) * 100}%` }} />
        <span style={{ flex: 1 }} />
      </div>
      <div className="balance-legend">
        <span>
          <i />
          赠送 {granted}
        </span>
        <span>
          <i />
          充值 {toppedUp}
        </span>
      </div>
    </div>
  );
}

export function PlaybackArt({ playing, artwork }: { playing: boolean; artwork?: string }) {
  return (
    <div className={`playback-art ${playing ? 'is-playing' : ''}`} aria-hidden="true">
      {artwork ? <img src={artwork} alt="" /> : <Disc3 size={48} strokeWidth={1} />}
    </div>
  );
}

export function UsagePreview({ items }: { items: { label: string; value: number | null }[] }) {
  return (
    <div className="adapter-visual usage-preview">
      {items.slice(0, 2).map((item) => (
        <div key={item.label}>
          <QuotaRing value={item.value} label={`${item.label}剩余`} />
          <span>
            {item.label}
            <strong>{item.value === null ? '—' : `${Number(item.value.toFixed(1))}%`}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrafficPlot({
  receive,
  send,
  area = false,
}: {
  receive: number[];
  send: number[];
  area?: boolean;
}) {
  const max = Math.max(10, ...receive, ...send);
  return (
    <div className="clash-trend-chart">
      {receive.length < 2 ? (
        <div className="view-chart-empty">等待流量采样</div>
      ) : (
        <>
          <Sparkline values={receive} area={area} scaleMax={max} />
          {send.length >= 2 ? <Sparkline values={send} secondary scaleMax={max} /> : null}
        </>
      )}
    </div>
  );
}

export function Sparkline({
  values,
  area = false,
  secondary = false,
  scaleMax,
}: {
  values: number[];
  area?: boolean;
  secondary?: boolean;
  scaleMax?: number;
}) {
  if (values.length < 2) return <div className="view-chart-empty">等待实时数据</div>;
  const max = (scaleMax ?? Math.max(10, ...values)) * 1.12;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 400},${94 - (Math.max(0, v) / max) * 84}`)
    .join(' ');
  const color = secondary ? 'var(--muted)' : 'var(--accent)';
  return (
    <svg
      className="view-chart"
      viewBox="0 0 400 100"
      preserveAspectRatio="none"
      aria-label="最近采样趋势"
      role="img"
    >
      <path className="chart-grid" d="M0 25H400 M0 55H400 M0 85H400" />
      {area ? <polygon points={`0,100 ${points} 400,100`} fill={color} opacity=".10" /> : null}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
