import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Copy, Link2, Monitor, Pencil, Plus, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import QRCode from 'qrcode';
import type { Device, Role } from '../../packages/protocol/src';
import { core, coreFleet } from './core';
import { hostName } from './core-fleet';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';
import { localCoreInfo } from './platform';
import { loopbackEndpoint } from './pairing';
import './devices.css';
import { RelayPanel } from './RelayPanel';

const roles: Record<Role, string> = { owner: '管理', operator: '查看与编辑', viewer: '仅查看' };
type PairingWindow = {
  code: string;
  expiresAt: string;
  fingerprint: string;
  endpoints?: string[];
  remote: boolean;
};
type Pending = { id: string; name: string; keyHash: string };

async function copyText(value: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      /* Older WebViews use the selection API. */
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    previous?.focus();
  }
}

function CopyValue({
  label,
  value,
  notify,
  className = '',
}: {
  label: string;
  value: string;
  notify: (s: string) => void;
  className?: string;
}) {
  return (
    <div className="connection-value">
      <div>
        <small>{label}</small>
        <span className={'mono ' + className}>{value}</span>
      </div>
      <Button
        className="icon-button"
        aria-label={'复制' + label}
        onClick={() =>
          void copyText(value)
            .then(() => notify('已复制' + label))
            .catch(() => notify('无法访问剪贴板，请选择文字复制'))
        }
      >
        <Copy size={17} />
      </Button>
    </div>
  );
}

export function DevicesPanel({
  owner,
  online,
  notify,
  onConnect,
}: {
  owner: boolean;
  online: boolean;
  notify: (s: string) => void;
  onConnect: () => void;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const hosts = useSyncExternalStore(coreFleet.subscribe, coreFleet.getSnapshot);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof localCoreInfo>>>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [windowData, setWindowData] = useState<PairingWindow | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [qr, setQR] = useState('');
  const [qrEndpoint, setQREndpoint] = useState('');
  const [remote, setRemote] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [edit, setEdit] = useState<Device | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [revoke, setRevoke] = useState<Device | null>(null);
  const endpoint = state.endpoint;
  const canManage = state.identity?.capabilities?.includes('device-management') === true;
  const canClosePairing = state.identity?.capabilities?.includes('pairing-close') === true;
  const expired = Boolean(windowData && Date.parse(windowData.expiresAt) <= now);
  const remaining = windowData
    ? Math.max(0, Math.ceil((Date.parse(windowData.expiresAt) - now) / 1000))
    : 0;
  const reload = async () => {
    setDevices(await core.api<Device[]>('/devices'));
  };
  useEffect(() => {
    void localCoreInfo()
      .then(setLocal)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!owner || !online) return;
    let stopped = false;
    const poll = async () => {
      try {
        const [nextDevices, nextPending] = await Promise.all([
          core.api<Device[]>('/devices'),
          core.api<Pending[]>('/pairing/pending'),
        ]);
        if (!stopped) {
          setPollError('');
          setDevices(nextDevices);
          setPending(nextPending);
        }
      } catch (e) {
        if (!stopped) setPollError(connectionErrorText(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [owner, online]);
  useEffect(() => {
    if (!windowData) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [windowData]);
  useEffect(() => {
    setQR('');
    if (!windowData || !endpoint || !qrEndpoint || expired) return;
    let stopped = false;
    void QRCode.toDataURL(
      JSON.stringify({
        schemaVersion: 1,
        endpoint: qrEndpoint,
        serverId: endpoint.serverId,
        fingerprint: windowData.fingerprint,
        code: windowData.code,
        expiresAt: windowData.expiresAt,
      }),
      { width: 220, margin: 2 },
    )
      .then((value) => {
        if (!stopped) setQR(value);
      })
      .catch((e) => {
        if (!stopped) setError(connectionErrorText(e));
      });
    return () => {
      stopped = true;
    };
  }, [windowData, qrEndpoint, endpoint, expired]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(connectionErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const openWindow = () =>
    run(async () => {
      const result = await core.api<PairingWindow>('/pairing/window', { remote });
      setWindowData(result);
      setNow(Date.now());
      setQREndpoint(
        loopbackEndpoint(endpoint!.uri) ? result.endpoints?.[0] || endpoint!.uri : endpoint!.uri,
      );
    });
  const approve = (id: string, accept: boolean, permission: Role) =>
    run(async () => {
      await core.api('/pairing/approve', { id, approve: accept, role: permission });
      setPending((items) => items.filter((item) => item.id !== id));
      if (accept) setWindowData(null);
      await reload();
      notify(accept ? '设备已配对' : '已拒绝配对请求');
    });
  const saveDevice = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const updated = await core.api<Device>(`/devices/${encodeURIComponent(edit!.id)}/update`, {
        name: name.trim(),
        role,
      });
      if (updated.id === state.device?.id) core.patch({ device: updated });
      setEdit(null);
      await reload();
      notify('设备信息已更新');
    });
  };
  return (
    <div className="devices-page">
      <div className="section-heading">
        <div className="eyebrow">CORES & DEVICES</div>
        <h1>设备与连接</h1>
        <p>连接多台主机，分别管理每个 Core 的访问设备与权限</p>
      </div>
      <section className="panel device-core-context">
        <div className="device-context-title">
          <span className="machine-icon">
            <Monitor size={24} />
          </span>
          <div>
            <small>正在管理的 Core</small>
            <h2>{hostName(state)}</h2>
            <p>
              {local?.fingerprint === endpoint?.publicKeyHash
                ? '这台电脑提供的 Core 服务'
                : '此设备连接的 Core 服务'}
            </p>
          </div>
          <span className="status-chip">
            <ShieldCheck size={15} />
            {online ? '已连接' : '离线缓存'}
          </span>
        </div>
        <CopyValue label="当前连接地址" value={endpoint?.uri || '未连接'} notify={notify} />
        <CopyValue
          label="SHA-256 身份指纹"
          value={endpoint?.publicKeyHash || ''}
          className="fingerprint"
          notify={notify}
        />
        <div className="device-context-footer">
          <span>
            Core ID <code>{endpoint?.serverId}</code>
          </span>
          <span>
            此设备：{state.device?.name} · {state.device ? roles[state.device.role] : '未授权'}
          </span>
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>我连接的 Core</h2>
            <p>每台主机独立配对，总览同时汇集已配对主机的数据</p>
          </div>
          <Button className="secondary" onClick={onConnect}>
            <Plus size={16} />
            管理 Core
          </Button>
        </div>
        <div className="device-host-list">
          {hosts.map((host) => (
            <div className="device-host" key={host.id}>
              <Monitor size={20} />
              <div>
                <strong>{hostName(host.state)}</strong>
                <span className="mono">{host.state.endpoint?.uri}</span>
                <small>
                  {host.active ? '当前管理' : '后台同步'} ·{' '}
                  {host.state.online
                    ? '在线'
                    : host.state.pairingRequired
                      ? '需要重新授权'
                      : '离线缓存'}
                </small>
              </div>
              {host.active ? (
                <span className="badge">当前</span>
              ) : (
                <Button
                  className="secondary"
                  disabled={state.switching || busy}
                  onClick={() =>
                    void run(async () => {
                      await core.switchEndpoint(host.state.endpoint!);
                    })
                  }
                >
                  切换
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>连接此 Core 的设备</h2>
            {owner && !canManage ? (
              <p>此 Core 使用旧版服务，请将目标主机升级到 0.1.34 或更新版本后修改设备名称与权限</p>
            ) : null}
            <p>这里的授权只属于 {hostName(state)}，另一台 Windows 主机连接时也作为设备授权</p>
          </div>
          {owner ? (
            <Button
              className="primary compact"
              disabled={!online || busy}
              onClick={() => void openWindow()}
            >
              <Plus size={16} />
              添加设备
            </Button>
          ) : null}
        </div>
        {owner ? (
          <>
            <label className="remote-toggle">
              <input
                type="checkbox"
                checked={remote}
                onChange={(e) => setRemote(e.target.checked)}
                disabled={busy}
              />
              此次允许远程配对（仍须在 Core 本机开启）
            </label>
            <div className="device-list">
              {devices.map((device) => (
                <div className="device-row" key={device.id}>
                  <span className="device-type">
                    <Monitor size={22} />
                  </span>
                  <div className="device-details">
                    <strong>
                      {device.name}
                      {device.id === state.device?.id ? (
                        <span className="badge">当前设备</span>
                      ) : null}
                    </strong>
                    <span>
                      {device.revokedAt
                        ? '已撤销'
                        : '最近认证 ' + new Date(device.lastSeenAt).toLocaleString('zh-CN')}
                    </span>
                    <small className="mono">设备 ID {device.id}</small>
                  </div>
                  <span className="badge">{roles[device.role]}</span>
                  <Button
                    className="icon-button"
                    aria-label={`编辑${device.name}`}
                    disabled={!online || busy || !canManage || Boolean(device.revokedAt)}
                    onClick={() => {
                      setEdit(device);
                      setName(device.name);
                      setRole(device.role);
                      setError('');
                    }}
                  >
                    <Pencil size={17} />
                  </Button>
                  <Button
                    className="icon-button danger-text"
                    aria-label={`撤销${device.name}`}
                    disabled={
                      !online || busy || Boolean(device.revokedAt) || device.id === state.device?.id
                    }
                    onClick={() => setRevoke(device)}
                  >
                    <Trash2 size={17} />
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="panel-empty">
            当前权限为{state.device ? roles[state.device.role] : '未授权'}
            ，请在管理设备上修改名称、权限或开启配对
          </p>
        )}
      </section>
      {windowData ? (
        <section className="panel device-pairing">
          <div className="panel-title">
            <div>
              <h2>在新设备上完成配对</h2>
              <p role="status">
                {expired
                  ? '配对码已过期，刷新后生成新码'
                  : `剩余 ${remaining} 秒 · ${windowData.remote ? '允许远程配对' : '局域网配对'}`}
              </p>
            </div>
            <div className="button-row">
              <Button
                className="secondary"
                disabled={!online || busy}
                onClick={() => void openWindow()}
              >
                <RotateCw size={16} />
                刷新配对码
              </Button>
              <Button
                className="icon-button"
                aria-label="关闭配对窗口"
                disabled={!online || busy || !canClosePairing}
                onClick={() =>
                  void run(async () => {
                    await core.api('/pairing/close', {});
                    setWindowData(null);
                    setPending([]);
                  })
                }
              >
                <X size={18} />
              </Button>
            </div>
          </div>
          <div className="pairing-panel">
            <div className="pairing-visual">
              {qr ? (
                <img src={qr} alt="包含地址、Core 指纹与一次性配对码的二维码" />
              ) : (
                <span>{expired ? '二维码已过期' : '正在生成二维码…'}</span>
              )}
              <small>在新设备扫描二维码</small>
            </div>
            <div className="pairing-fields">
              <label>
                二维码连接地址
                <select
                  aria-label="二维码连接地址"
                  value={qrEndpoint}
                  onChange={(e) => setQREndpoint(e.target.value)}
                >
                  {[...new Set([qrEndpoint, ...(windowData.endpoints || [])])].map((address) => (
                    <option key={address} value={address}>
                      {address}
                    </option>
                  ))}
                </select>
              </label>
              <CopyValue label="Core 地址" value={qrEndpoint} notify={notify} />
              {!expired ? (
                <CopyValue
                  label="配对码"
                  value={windowData.code}
                  className="pairing-code"
                  notify={notify}
                />
              ) : null}
              <CopyValue
                label="Core 指纹"
                value={windowData.fingerprint}
                className="fingerprint"
                notify={notify}
              />
            </div>
          </div>
          <div className="device-pairing-help">
            <Link2 size={18} />
            <p>
              同一局域网使用上方地址；通过 UU
              连接时，新设备填写它自己的本地映射地址，再使用这里的指纹与配对码
              <br />
              例如 https://127.0.0.1:19443 仅在已建立该端口映射的电脑上有效，远端 Core
              的本机地址不能直接复制给另一台电脑
            </p>
          </div>
        </section>
      ) : null}
      {pending.map((request) => (
        <section className="panel pending-panel" key={request.id}>
          <h3>
            {request.name} 请求连接 {hostName(state)}
          </h3>
          <p>核对此设备名称及设备公钥指纹后批准</p>
          <p className="mono fingerprint">{request.keyHash}</p>
          <div className="button-row">
            <Button
              className="secondary"
              disabled={busy}
              onClick={() => void approve(request.id, false, 'viewer')}
            >
              拒绝
            </Button>
            <Button
              className="secondary"
              disabled={busy}
              onClick={() => void approve(request.id, true, 'viewer')}
            >
              允许查看
            </Button>
            <Button
              className="primary"
              disabled={busy}
              onClick={() => void approve(request.id, true, 'operator')}
            >
              允许查看与编辑
            </Button>
          </div>
        </section>
      ))}
      {(error || pollError) && !edit && !revoke ? (
        <div className="form-error" role="alert">
          {error || pollError}
        </div>
      ) : null}
      <RelayPanel notify={notify} />
      {edit ? (
        <Modal
          title="编辑设备"
          close={() => {
            if (!busy) setEdit(null);
          }}
        >
          <form className="form-stack" onSubmit={saveDevice}>
            <p className="connection-intro">修改 {hostName(state)} 中的设备信息，保留原有配对</p>
            <label>
              设备名称
              <input
                required
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              设备权限
              <select
                aria-label="设备权限"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={edit.id === state.device?.id}
              >
                {Object.entries(roles).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
              <small>
                {edit.id === state.device?.id
                  ? '当前管理设备的权限只能由另一台管理设备修改'
                  : '权限变更后设备会重新连接，立即使用新权限'}
              </small>
            </label>
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
            <Button
              className="primary full"
              type="submit"
              disabled={!online || !name.trim()}
              pending={busy}
            >
              保存设备信息
            </Button>
          </form>
        </Modal>
      ) : null}
      {revoke ? (
        <Modal
          title="撤销设备"
          close={() => {
            if (!busy) setRevoke(null);
          }}
        >
          <p>
            撤销「{revoke.name}」后，它会立即断开与 {hostName(state)}{' '}
            的连接，需要重新批准配对才能访问
          </p>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <Button
            className="danger"
            pending={busy}
            onClick={() =>
              void run(async () => {
                await core.api(`/devices/${encodeURIComponent(revoke.id)}/revoke`, {});
                setRevoke(null);
                await reload();
                notify('设备授权已撤销');
              })
            }
          >
            确认撤销
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}
