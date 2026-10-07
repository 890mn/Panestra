import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  AudioLines,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  AlertCircle,
  X,
  LockKeyhole,
} from 'lucide-react';
import { NETEASE_TOPIC, type MediaStatus } from '../../packages/protocol/src';
import { core } from './core';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';
import { PlaybackArt } from './AdapterVisuals';

export const musicState = (status: MediaStatus | undefined, online: boolean) =>
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
            : status.state === 'not_found'
              ? '未找到播放器'
              : '暂不可用';
const playbackName = (value: string) =>
  ({
    Playing: '播放中',
    Paused: '已暂停',
    Stopped: '已停止',
    Closed: '已关闭',
    Opened: '已打开',
    Changing: '正在切换',
  })[value] || '—';
const time = (seconds: number | null | undefined) =>
  seconds == null
    ? '—'
    : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function usePlaybackPosition(status: MediaStatus | undefined, active: boolean) {
  const [position, setPosition] = useState(status?.positionSeconds ?? 0);
  const actual = status?.positionSeconds ?? 0;
  const duration = status?.durationSeconds ?? 0;
  const playing =
    active &&
    !!status?.timelineSource &&
    !status?.stale &&
    status?.playback === 'Playing' &&
    duration > 0;
  useEffect(() => {
    setPosition(actual);
    if (!playing) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > 4) {
        window.clearInterval(timer);
        return;
      }
      setPosition(Math.min(duration, actual + elapsed));
    }, 250);
    return () => window.clearInterval(timer);
  }, [actual, duration, playing, status?.updatedAt, status?.trackId]);
  return playing ? position : actual;
}

export function MusicControls({
  status,
  online,
  small = false,
  editing = false,
  seek = false,
  buttons = true,
  inlineError = false,
}: {
  status?: MediaStatus;
  online: boolean;
  small?: boolean;
  editing?: boolean;
  seek?: boolean;
  buttons?: boolean;
  inlineError?: boolean;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [draft, setDraft] = useState<number | null>(null);
  const pending = useRef(false);
  const drag = useRef<{ pointerId: number; trackId?: string } | null>(null);
  const position = usePlaybackPosition(status, online && seek);
  const allowed =
    online &&
    status?.enabled &&
    status.allowControl &&
    status.state === 'ready' &&
    !status.stale &&
    !editing &&
    ['owner', 'operator'].includes(state.device?.role || '');
  const perform = async (action: string, positionSeconds?: number, trackId = status?.trackId) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await core.api('/integrations/netease/actions', {
        action,
        ...(positionSeconds === undefined ? {} : { positionSeconds, trackId }),
      });
    } catch (err) {
      setError(connectionErrorText(err));
    } finally {
      setBusy(false);
      pending.current = false;
      setDraft(null);
    }
  };
  const duration = status?.durationSeconds;
  const reason = !online
    ? 'Core 离线'
    : !status?.enabled
      ? '未启用'
      : !status.allowControl
        ? '未授权'
        : !['owner', 'operator'].includes(state.device?.role || '')
          ? '只读设备'
          : status.stale
            ? '数据过期'
            : status.state !== 'ready'
              ? '未连接'
              : '';
  return (
    <div className={`music-actions ${small ? 'is-small' : ''}`}>
      {seek ? (
        <label className={`music-seek ${duration ? '' : 'is-unavailable'}`}>
          <input
            aria-label="播放进度"
            type="range"
            min={0}
            max={duration || 1}
            step={1}
            value={draft ?? position}
            style={
              {
                '--music-progress': `${duration ? Math.max(0, Math.min(100, ((draft ?? position) / duration) * 100)) : 0}%`,
              } as CSSProperties
            }
            disabled={!allowed || busy || !status?.controls.seek || !duration}
            onPointerDown={(event) => {
              if (!allowed || busy || !status?.controls.seek || !duration) return;
              drag.current = { pointerId: event.pointerId, trackId: status.trackId };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onChange={(event) => setDraft(Number(event.target.value))}
            onPointerUp={(event) => {
              const current = drag.current;
              drag.current = null;
              if (current && allowed && !busy && status?.controls.seek && duration)
                void perform('seek', Number(event.currentTarget.value), current.trackId);
            }}
            onKeyUp={(event) => {
              if (
                allowed &&
                status?.controls.seek &&
                duration &&
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(event.key)
              )
                void perform('seek', Number(event.currentTarget.value));
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDraft(null);
            }}
            onLostPointerCapture={() => {
              if (drag.current) {
                drag.current = null;
                setDraft(null);
              }
            }}
            onBlur={() => {
              if (!pending.current && !drag.current) setDraft(null);
            }}
          />
          <span className="music-time">
            <span>{time(draft ?? (duration ? position : null))}</span>
            {!duration ? <span>播放器未提供进度</span> : null}
            <span>{time(duration)}</span>
          </span>
        </label>
      ) : null}
      {buttons ? (
        <div className="music-buttons" aria-label="网易云播放控制">
          {!small ? (
            <Button
              className="icon-button secondary"
              aria-label="网易云上一首"
              data-music-skip
              disabled={!allowed || busy || !status?.controls.previous}
              onClick={() => void perform('previous')}
            >
              <SkipBack size={18} />
            </Button>
          ) : null}
          <Button
            className="icon-button secondary"
            aria-label={status?.playback === 'Playing' ? '网易云暂停' : '网易云播放'}
            pending={busy}
            disabled={!allowed || busy || !status?.controls.toggle}
            onClick={() => void perform('toggle')}
          >
            {status?.playback === 'Playing' ? <Pause size={18} /> : <Play size={18} />}
          </Button>
          {!small ? (
            <Button
              className="icon-button secondary"
              aria-label="网易云下一首"
              data-music-skip
              disabled={!allowed || busy || !status?.controls.next}
              onClick={() => void perform('next')}
            >
              <SkipForward size={18} />
            </Button>
          ) : null}
          {reason ? (
            <span className="music-access">
              <LockKeyhole size={12} />
              {reason}
            </span>
          ) : null}
        </div>
      ) : null}
      {error && inlineError ? (
        <p className="form-error music-error" role="alert">
          {error}
        </p>
      ) : error ? (
        createPortal(
          <div className="toast" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <Button
              className="icon-button"
              aria-label="关闭播放错误提示"
              onClick={() => setError('')}
            >
              <X size={18} />
            </Button>
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}

export function musicContents({
  status,
  online,
  compact = false,
  small = false,
  mode = 'auto',
  height = 600,
  width = 800,
  expanded = false,
  editing = false,
  inlineControls = expanded,
}: {
  status?: MediaStatus;
  online: boolean;
  compact?: boolean;
  small?: boolean;
  mode?: string;
  height?: number;
  width?: number;
  expanded?: boolean;
  editing?: boolean;
  inlineControls?: boolean;
}) {
  const artwork = !compact && width >= 240 && (height >= (width >= 380 ? 170 : 210) || expanded);
  return (
    <>
      <div
        data-block="track"
        className={`music-track ${compact ? 'is-small' : ''} ${expanded ? 'is-expanded' : ''} ${artwork ? 'with-artwork' : ''} ${artwork && mode === 'focus' && width >= 480 && height >= 300 ? 'focus-artwork' : ''}`}
      >
        {artwork ? (
          <PlaybackArt
            playing={online && !status?.stale && status?.playback === 'Playing'}
            artwork={status?.artworkDataUrl}
            vinyl={mode === 'vinyl'}
          />
        ) : null}
        <div className="music-track-copy">
          <strong title={status?.title || ''}>{status?.title || '暂无歌曲'}</strong>
          {!compact ? (
            <span className="view-muted" title={status?.artist || ''}>
              {status?.artist || '歌手未知'}
            </span>
          ) : null}
          {height >= 240 || expanded ? (
            <span className="music-playback">
              <i
                className={
                  online && !status?.stale && status?.playback === 'Playing' ? 'active' : ''
                }
              />
              {playbackName(status?.playback || '')}
            </span>
          ) : null}
        </div>
      </div>
      {mode !== 'track' ? (
        <div data-block="controls">
          <MusicControls
            status={status}
            online={online}
            small={small || compact}
            editing={editing}
            inlineError={expanded}
          />
        </div>
      ) : null}
      {height >= (inlineControls ? 135 : 190) || expanded ? (
        <div data-block="progress" className="music-progress">
          <MusicControls
            status={status}
            online={online}
            editing={editing}
            seek
            buttons={false}
            inlineError={expanded}
          />
        </div>
      ) : null}
      {(height >= 320 || expanded) && status?.album ? (
        <div data-block="album" className="music-album">
          <span className="view-muted">专辑</span>
          <span>{status.album}</span>
        </div>
      ) : null}
      {height >= 380 || expanded ? (
        <p data-block="status" className="view-muted account-message">
          {musicState(status, online)} · {playbackName(status?.playback || '')}
          {status?.stale || !online ? ' · 历史数据' : ''}
        </p>
      ) : null}
      {(height >= 440 || expanded) && status?.updatedAt ? (
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

export function MusicAdapterCard() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const status = state.telemetry[NETEASE_TOPIC]?.value as MediaStatus | undefined;
  const [detail, setDetail] = useState(false),
    [allowControl, setAllowControl] = useState(false),
    [localTimeline, setLocalTimeline] = useState(false),
    [timelinePort, setTimelinePort] = useState('19228'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = state.device?.role === 'owner';
  const request = async (path: string, body: unknown) => {
    setBusy(true);
    setError('');
    try {
      const saved = await core.api<MediaStatus>('/integrations/netease' + path, body);
      if (!path) setAllowControl(saved.allowControl);
    } catch (err) {
      setError(connectionErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="adapter-card panel" data-testid="netease-adapter">
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <AudioLines size={22} />
        </span>
        <span className="adapter-state">
          <span
            className={`status-light ${state.online && status?.state === 'ready' && !status.stale ? '' : 'offline'}`}
          />
          {musicState(status, state.online)}
        </span>
      </div>
      <h3>网易云音乐</h3>
      <span className="adapter-subtitle">播放控制</span>
      <p>查看歌曲、歌手与进度，在设备间控制播放</p>
      <div className="adapter-visual adapter-music">
        <PlaybackArt
          playing={state.online && !status?.stale && status?.playback === 'Playing'}
          artwork={status?.artworkDataUrl}
        />
        <div>
          <strong title={status?.title}>{status?.title || '等待歌曲信息'}</strong>
          <span>{status?.artist || '在电脑上打开网易云音乐'}</span>
          <span className="music-playback">{playbackName(status?.playback || '')}</span>
        </div>
      </div>
      <div className="adapter-fields">
        <div>
          <span>歌曲</span>
          <span title={status?.title}>{status?.title || '—'}</span>
        </div>
        <div>
          <span>控制权限</span>
          <span>{status?.allowControl ? '已授权' : '只读'}</span>
        </div>
      </div>
      <Button
        className="secondary"
        aria-label="查看网易云播放状态与设置"
        onClick={() => {
          setAllowControl(status?.allowControl ?? false);
          setLocalTimeline(!!status?.timelinePort);
          setTimelinePort(String(status?.timelinePort || 19228));
          setDetail(true);
        }}
      >
        状态与设置
        <ArrowRight size={16} />
      </Button>
      {detail ? (
        <Modal
          title="网易云音乐 · 播放控制"
          close={() => {
            setDetail(false);
            setError('');
          }}
          wide
        >
          <div className="music-detail-content">
            {musicContents({ status, online: state.online, mode: 'player', expanded: true })}
          </div>
          {status?.enabled && !status.allowControl ? (
            <div className="music-permission-note">
              <LockKeyhole size={18} />
              <span>
                {owner
                  ? '当前只读取歌曲信息，开启播放控制后才能操作'
                  : '当前是只读模式，请在电脑端网易云适配中开启播放控制'}
              </span>
              {owner ? (
                <Button
                  className="secondary"
                  pending={busy}
                  disabled={!state.online}
                  onClick={() => void request('', { enabled: true, allowControl: true })}
                >
                  开启播放控制
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="subtle">
            {status?.message || '在 Core 电脑上打开网易云音乐，并在播放器设置中启用系统媒体控制'}
          </p>
          {status?.timelineMessage ? <p className="subtle">{status.timelineMessage}</p> : null}
          <div className="adapter-boundary">
            <ShieldCheck size={18} />
            <p>只读取已识别的网易云会话，不操作其他播放器</p>
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
                void request('', {
                  enabled: true,
                  allowControl,
                  timelinePort: localTimeline ? Number(timelinePort) : 0,
                });
              }}
            >
              <label className="permission-row">
                <span>允许播放、切歌与调整进度</span>
                <input
                  type="checkbox"
                  checked={allowControl}
                  onChange={(event) => setAllowControl(event.target.checked)}
                />
              </label>
              <label className="permission-row">
                <span>使用本机进度通道</span>
                <input
                  type="checkbox"
                  checked={localTimeline}
                  onChange={(event) => setLocalTimeline(event.target.checked)}
                />
              </label>
              {localTimeline ? (
                <>
                  <label>
                    本机进度端口
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      required
                      value={timelinePort}
                      onChange={(event) => setTimelinePort(event.target.value)}
                    />
                  </label>
                  <p className="subtle">在电脑上关闭网易云后，使用以下参数启动播放器，再保存设置</p>
                  <code className="music-launch-arguments">
                    --remote-debugging-address=127.0.0.1 --remote-debugging-port={timelinePort}
                  </code>
                  <p className="subtle">
                    通道仅连接本机，提供真实进度与拖动跳转，关闭后仍可使用系统播放控制
                  </p>
                </>
              ) : null}
              <div className="button-row">
                <Button className="primary" type="submit" pending={busy} disabled={!state.online}>
                  保存并启用读取
                </Button>
                {status?.enabled ? (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('', { enabled: false })}
                  >
                    停用读取
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="subtle">只有 Owner 可以启用读取或授权播放控制</p>
          )}
          <Button
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
