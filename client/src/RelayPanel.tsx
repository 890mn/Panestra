import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ArrowRight, Network, Plus, Settings2, Trash2 } from 'lucide-react';
import type { Device } from '../../packages/protocol/src';
import { coreFleet } from './core';
import { hostName } from './core-fleet';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';
import type { RelayInfo } from './relay-types';
import './relays.css';

export function RelayPanel({ notify }: { notify: (message: string) => void }) {
  const hosts = useSyncExternalStore(coreFleet.subscribe, coreFleet.getSnapshot);
  const gateways = hosts.filter(
    (host) =>
      !host.state.endpoint?.relay &&
      host.state.device?.role === 'owner' &&
      host.state.identity?.capabilities?.includes('core-relay'),
  );
  const [chosen, setChosen] = useState('');
  const gateway =
    gateways.find((host) => host.id === chosen) ||
    gateways.find((host) => host.active) ||
    gateways[0];
  const client = gateway?.client;
  const [routes, setRoutes] = useState<RelayInfo[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [editing, setEditing] = useState<RelayInfo | 'new' | null>(null);
  const [uri, setURI] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [grants, setGrants] = useState<Record<string, 'viewer' | 'operator'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<RelayInfo | null>(null);
  const [formGateway, setFormGateway] = useState('');
  useEffect(() => {
    setRoutes([]);
    setDevices([]);
    setEditing(null);
    setRemoving(null);
    setError('');
    if (!client) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [next, list] = await Promise.all([
          client.api<RelayInfo[]>('/relays'),
          client.api<Device[]>('/devices'),
        ]);
        if (!stopped) {
          setRoutes(next);
          setDevices(list.filter((device) => !device.revokedAt));
        }
      } catch (e) {
        if (!stopped) setError(connectionErrorText(e));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client]);
  const open = (route?: RelayInfo) => {
    if (!gateway) return;
    setFormGateway(gateway.id);
    setEditing(route || 'new');
    setURI(route?.uri || '');
    setFingerprint(route?.fingerprint || '');
    setName(route?.name || '');
    setCode('');
    setError('');
    setGrants(
      route?.grants
        ? Object.fromEntries(
            Object.entries(route.grants).filter(([id]) =>
              devices.some((device) => device.id === id),
            ),
          )
        : gateway.state.device
          ? { [gateway.state.device.id]: 'viewer' }
          : {},
    );
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !gateway || gateway.id !== formGateway) return;
    setBusy(true);
    setError('');
    try {
      await client.api('/relays', {
        uri: uri.trim(),
        fingerprint: fingerprint.trim(),
        name: name.trim(),
        code: code.trim(),
        grants,
      });
      setEditing(null);
      setCode('');
      setRoutes(await client.api<RelayInfo[]>('/relays'));
      await coreFleet.refreshRelays();
      notify(code ? '中转配对已发起，请在远端 Core 批准这台主机' : '中转授权已更新');
    } catch (e) {
      setError(connectionErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel relay-panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow">CORE RELAY</div>
          <h2>主机中转</h2>
          <p className="subtle">由 Windows 主机访问远端，手机和平板只连接这台主机</p>
        </div>
        <Button
          className="secondary"
          disabled={!gateway?.state.online || !devices.length}
          onClick={() => open()}
        >
          <Plus size={16} />
          添加中转 Core
        </Button>
      </div>
      {gateways.length > 1 ? (
        <label className="relay-gateway">
          中转主机
          <select value={gateway?.id || ''} onChange={(event) => setChosen(event.target.value)}>
            {gateways.map((host) => (
              <option key={host.id} value={host.id}>
                {hostName(host.state)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="relay-flow">
        <span>
          <Network size={16} />
          手机 / 平板
        </span>
        <ArrowRight size={16} />
        <strong>{gateway ? hostName(gateway.state) : 'Windows Core'}</strong>
        <ArrowRight size={16} />
        <span>远端 Core</span>
      </div>
      {!gateway ? (
        <p className="subtle">请用管理设备连接支持中转的 Windows Core，再为各设备授权</p>
      ) : null}
      {gateway && !routes.length ? (
        <p className="subtle">添加远端 Core 的映射地址，批准中转配对后，为需要访问的设备选择权限</p>
      ) : null}
      {routes.map((route) => (
        <div className="relay-row" key={route.id}>
          <div>
            <strong>{route.name}</strong>
            <small className="mono">{route.uri}</small>
            <small>
              <span className={`status-light ${route.online ? '' : 'offline'}`} />
              {route.online
                ? '中转运行中'
                : route.status === 'pending'
                  ? '等待远端批准中转配对'
                  : route.status === 'pairing-required'
                    ? '需要重新配对'
                    : '正在重连'}{' '}
              ·{' '}
              {
                Object.keys(route.grants || {}).filter((id) =>
                  devices.some((device) => device.id === id),
                ).length
              }{' '}
              台设备获授权
            </small>
            {route.error ? <small className="form-error">{route.error}</small> : null}
          </div>
          <Button
            className="icon-button"
            aria-label={'设置' + route.name + '中转'}
            onClick={() => open(route)}
          >
            <Settings2 size={17} />
          </Button>
          <Button
            className="icon-button"
            aria-label={'移除' + route.name + '中转'}
            onClick={() => setRemoving(route)}
          >
            <Trash2 size={17} />
          </Button>
        </div>
      ))}
      <p className="relay-help">
        主机上的映射必须保持开启，中转 Core 也需要保持运行，可切换为后台模式
        <br />
        移动端无需开启映射，只需能够连接中转主机的局域网或可达地址
      </p>
      {error && !editing ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {editing ? (
        <Modal
          title={editing === 'new' ? '添加中转 Core' : '中转与设备授权'}
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form className="form-stack" onSubmit={(event) => void save(event)}>
            {editing === 'new' ? (
              <label>
                使用已连接 Core 的地址
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const host = hosts.find((host) => host.id === event.target.value);
                    if (host?.state.endpoint) {
                      setURI(host.state.endpoint.uri);
                      setFingerprint(host.state.endpoint.publicKeyHash);
                      setName(hostName(host.state));
                    }
                  }}
                >
                  <option value="">手动填写</option>
                  {hosts
                    .filter((host) => host.id !== gateway?.id && !host.state.endpoint?.relay)
                    .map((host) => (
                      <option value={host.id} key={host.id}>
                        {hostName(host.state)}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <label>
              远端名称
              <input
                value={name}
                maxLength={128}
                onChange={(event) => setName(event.target.value)}
                placeholder="家中主机"
              />
            </label>
            <label>
              远端 Core 地址
              <input
                aria-label="远端 Core 地址"
                value={uri}
                onChange={(event) => setURI(event.target.value)}
                required
                placeholder="https://127.0.0.1:19443"
                readOnly={editing !== 'new'}
              />
              <small>填写中转主机能访问的地址，UU 本地映射地址只由这台主机使用</small>
            </label>
            <label>
              远端 SHA-256 指纹
              <input
                className="mono"
                value={fingerprint}
                onChange={(event) => setFingerprint(event.target.value)}
                required
                readOnly={editing !== 'new'}
              />
            </label>
            <label>
              {editing === 'new' ? '远端配对码' : '重新配对码（可选）'}
              <input
                aria-label={editing === 'new' ? '远端配对码' : '重新配对码'}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required={editing === 'new'}
                autoComplete="off"
              />
              <small>
                在远端 Core 本机打开允许远程连接的配对窗口，然后批准「Panestra 中转」请求
              </small>
            </label>
            <fieldset className="relay-grants">
              <legend>允许哪些设备访问</legend>
              {devices.map((device) => (
                <label key={device.id}>
                  <span>
                    {device.name}
                    {device.id === gateway?.state.device?.id ? '（当前设备）' : ''}
                  </span>
                  <select
                    aria-label={device.name + '中转权限'}
                    value={grants[device.id] || ''}
                    onChange={(event) => {
                      const next = { ...grants };
                      if (event.target.value)
                        next[device.id] = event.target.value as 'viewer' | 'operator';
                      else delete next[device.id];
                      setGrants(next);
                    }}
                  >
                    <option value="">不共享</option>
                    <option value="viewer">仅查看</option>
                    <option value="operator">查看与操作</option>
                  </select>
                </label>
              ))}
            </fieldset>
            <p className="subtle">
              操作权限同时受设备在中转主机上的权限及远端授权限制，不共享设备管理、凭据或插件设置
            </p>
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
            <Button
              type="submit"
              className="primary full"
              pending={busy}
              disabled={!gateway?.state.online}
            >
              {editing === 'new' ? '建立中转' : '保存中转授权'}
            </Button>
          </form>
        </Modal>
      ) : null}
      {removing ? (
        <Modal
          title="移除中转"
          close={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <p>移除「{removing.name}」后，共享设备会立即失去此主机的中转入口，远端配对记录保留</p>
          <Button
            className="danger"
            pending={busy}
            onClick={() => {
              if (!client) return;
              setBusy(true);
              void client
                .api(`/relays/${encodeURIComponent(removing.id)}/remove`, {})
                .then(async () => {
                  setRemoving(null);
                  setRoutes(await client.api<RelayInfo[]>('/relays'));
                  await coreFleet.refreshRelays();
                })
                .catch((e) => setError(connectionErrorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            移除中转
          </Button>
        </Modal>
      ) : null}
    </section>
  );
}
