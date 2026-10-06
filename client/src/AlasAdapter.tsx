import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, Bot, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { ALAS_TOPIC, type AlasStatus } from '../../packages/protocol/src';
import { core } from './core';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';

export const alasState = (status: AlasStatus | undefined, online: boolean) =>
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
            : status.state === 'bridge_required'
              ? '等待桥接启动'
              : status.state === 'instance_missing'
                ? '实例未载入'
                : '暂不可用';
const instanceState = (state?: string) =>
  ({ running: '运行中', stopped: '已停止', error: '异常停止', updating: '更新中' })[state || ''] ||
  '未知';
const scheduledTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function alasContents({
  status,
  online,
  compact = false,
  height = 600,
  mode = 'auto',
  expanded = false,
}: {
  status?: AlasStatus;
  online: boolean;
  compact?: boolean;
  height?: number;
  mode?: string;
  expanded?: boolean;
}) {
  const instance = status?.instances.find((item) => item.name === status.instance);
  const valid = status?.enabled && status.state === 'ready' && !status.stale && online;
  return (
    <>
      <div data-block="status" className={`alas-status ${compact ? 'is-small' : ''}`}>
        <strong>{valid ? instanceState(instance?.state) : alasState(status, online)}</strong>
        {!compact ? (
          <span className="view-muted">
            {status?.instance || 'alas'}
            {!valid && instance ? ' · 历史数据' : ''}
          </span>
        ) : null}
      </div>
      {!compact && (height >= 130 || expanded) ? (
        <div data-block="current" className="alas-task">
          <span className="view-muted">{instance?.waitingTask ? '等待执行' : '当前任务'}</span>
          <strong title={instance?.currentTask || instance?.waitingTask || ''}>
            {instance?.currentTask || instance?.waitingTask || '—'}
          </strong>
        </div>
      ) : null}
      {(height >= 230 || expanded) && instance?.tasks[0] ? (
        <div data-block="next" className="alas-task">
          <span className="view-muted">下次执行</span>
          <strong title={instance.tasks[0].name}>{instance.tasks[0].name}</strong>
          <span className="view-muted">{scheduledTime(instance.tasks[0].nextRun)}</span>
        </div>
      ) : null}
      {(height >= 360 || expanded) && (mode !== 'summary' || expanded) && instance?.tasks.length ? (
        <div data-block="queue" className="alas-queue">
          {instance.tasks
            .slice(0, expanded ? 20 : Math.max(1, Math.floor((height - 280) / 44)))
            .map((task, i) => (
              <div key={`${task.name}-${i}`}>
                <span title={task.name}>{task.name}</span>
                <time>{scheduledTime(task.nextRun)}</time>
              </div>
            ))}
        </div>
      ) : null}
      {(height >= 460 || expanded) && status?.updatedAt ? (
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
type Setup = { root: string; port: number; instance: string; launcher: string; prepared: boolean };
export function AlasAdapterCard() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const status = state.telemetry[ALAS_TOPIC]?.value as AlasStatus | undefined;
  const owner = state.device?.role === 'owner';
  const [detail, setDetail] = useState(false),
    [setup, setSetup] = useState<Setup | null>(null),
    [root, setRoot] = useState(''),
    [port, setPort] = useState('22267'),
    [instance, setInstance] = useState('alas'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const load = async () => {
    const value = (await core.api('/integrations/alas/setup')) as Setup;
    setSetup(value);
    setRoot(value.root);
    setPort(String(value.port));
    setInstance(value.instance);
  };
  const request = async (path: string, body: unknown) => {
    setBusy(true);
    setError('');
    try {
      await core.api('/integrations/alas' + path, body);
      if (owner && path !== '/refresh') await load();
    } catch (err) {
      setError(connectionErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="adapter-card panel" data-testid="alas-adapter">
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <Bot size={22} />
        </span>
        <span className="adapter-state">
          <span
            className={`status-light ${state.online && status?.state === 'ready' && !status.stale ? '' : 'offline'}`}
          />
          {alasState(status, state.online)}
        </span>
      </div>
      <h3>ALAS</h3>
      <span className="adapter-subtitle">脚本状态</span>
      <p>查看 Azur Lane AutoScript 实例、当前任务与调度队列</p>
      <div className="adapter-fields">
        <div>
          <span>实例</span>
          <span>{status?.instance || 'alas'}</span>
        </div>
        <div>
          <span>运行状态</span>
          <span>
            {status?.state === 'ready' && !status.stale && state.online
              ? instanceState(status.instances.find((item) => item.name === status.instance)?.state)
              : '—'}
          </span>
        </div>
      </div>
      <Button
        className="secondary"
        aria-label="查看ALAS状态与设置"
        onClick={() => {
          setDetail(true);
          setError('');
          if (owner && state.online) {
            setBusy(true);
            void load()
              .catch((err) => setError(connectionErrorText(err)))
              .finally(() => setBusy(false));
          }
        }}
      >
        状态与设置
        <ArrowRight size={16} />
      </Button>
      {detail ? (
        <Modal
          title="ALAS · 脚本状态"
          wide
          close={() => {
            setDetail(false);
            setError('');
            setCopied(false);
          }}
        >
          <div className="alas-detail-content">
            {alasContents({ status, online: state.online, expanded: true })}
          </div>
          <p className="subtle">{status?.message || '通过 ALAS 本机只读桥接读取实例状态'}</p>
          <div className="adapter-boundary">
            <ShieldCheck size={18} />
            <p>从实际 WebUI 的 ProcessManager 读取状态，不启动、停止或操作游戏任务</p>
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
                void request('/prepare', { root, port: Number(port), instance, enabled: true });
              }}
            >
              <label>
                ALAS 安装目录
                <input
                  value={root}
                  maxLength={4096}
                  placeholder="Core 电脑上的 ALAS 目录"
                  disabled={busy || !setup}
                  onChange={(event) => setRoot(event.target.value)}
                  required
                />
              </label>
              <div className="form-grid">
                <label>
                  WebUI 端口
                  <input
                    type="number"
                    disabled={busy || !setup}
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    required
                  />
                </label>
                <label>
                  实例名称
                  <input
                    value={instance}
                    maxLength={80}
                    pattern="[A-Za-z0-9_-]+"
                    disabled={busy || !setup}
                    onChange={(event) => setInstance(event.target.value)}
                    required
                  />
                </label>
              </div>
              <div className="button-row">
                <Button type="submit" className="primary" pending={busy} disabled={!state.online}>
                  生成桥接并启用读取
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
                {status?.hasConfiguration ? (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('', { clearConfiguration: true })}
                  >
                    移除连接设置
                  </Button>
                ) : null}
              </div>
              {setup?.launcher ? (
                <div className="alas-launcher">
                  <p>先停止现有 ALAS，使用以下启动文件打开 WebUI，再刷新状态</p>
                  <code>{setup.launcher}</code>
                  <p className="subtle">保留 ALAS 原有的自动运行和重载设置，重启会中断当前任务</p>
                  <Button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(
                          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${setup.launcher}"`,
                        )
                        .then(() => setCopied(true))
                        .catch(() => setError('复制失败，请手动复制启动文件路径'));
                    }}
                  >
                    <Copy size={18} />
                    {copied ? '已复制启动命令' : '复制启动命令'}
                  </Button>
                </div>
              ) : null}
            </form>
          ) : (
            <p className="subtle">只有 Owner 可以配置 ALAS 本机桥接</p>
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
