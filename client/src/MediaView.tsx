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
import { type MediaStatus } from '../../packages/protocol/src';
import { useCoreClient } from './CoreScope';
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
  pluginId,
  status,
  online,
  small = false,
  editing = false,
  seek = false,
  buttons = true,
  inlineError = false,
}: {
  pluginId: string;
  status?: MediaStatus;
  online: boolean;
  small?: boolean;
  editing?: boolean;
  seek?: boolean;
  buttons?: boolean;
  inlineError?: boolean;
}) {
  const core = useCoreClient();
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
      await core.pluginRequest(pluginId, 'control', {
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
  pluginId,
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
  pluginId: string;
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
            pluginId={pluginId}
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
            pluginId={pluginId}
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
