import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Link2,
  Monitor,
  Plus,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import type { Endpoint } from '../../packages/protocol/src';
import { core, coreFleet } from './core';
import { hostName } from './core-fleet';
import { coreName, saveCoreName } from './core-names';
import { connectionErrorText } from './connection-errors';
import { Button } from './components';
import './core-connections.css';

function addressName(endpoint: Endpoint) {
  try {
    return new URL(endpoint.uri).host;
  } catch {
    return endpoint.uri;
  }
}

export function CoreConnections({
  currentName,
  addCore,
  onConnected,
  repairing = false,
}: {
  currentName?: string;
  addCore: (done: () => void, endpoint?: Endpoint) => ReactNode;
  onConnected: () => void;
  repairing?: boolean;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const hosts = useSyncExternalStore(coreFleet.subscribe, coreFleet.getSnapshot);
  const [view, setView] = useState<'list' | 'add' | 'repair' | 'address' | 'remote'>(
    repairing ? 'repair' : 'list',
  );
  const [expanded, setExpanded] = useState(state.endpoint?.serverId || '');
  const [target, setTarget] = useState<Endpoint | null>(null);
  const [uri, setURI] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [renaming, setRenaming] = useState('');
  const [name, setName] = useState('');
  const groups = new Map<string, Endpoint[]>();
  for (const endpoint of [
    ...hosts.flatMap((host) => (host.state.endpoint ? [host.state.endpoint] : [])),
    ...state.knownEndpoints,
  ]) {
    const group = groups.get(endpoint.serverId) || [];
    if (!group.some((item) => item.uri === endpoint.uri)) group.push(endpoint);
    groups.set(endpoint.serverId, group);
  }
  const navigate = (next: typeof view) => {
    setError('');
    setView(next);
  };
  const connect = async (endpoint: Endpoint) => {
    setError('');
    setPending(endpoint.uri);
    try {
      await core.switchEndpoint(endpoint);
      onConnected();
    } catch (e) {
      setError(connectionErrorText(e));
    } finally {
      setPending('');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (target) void connect({ ...target, uri: uri.trim() });
  };
  return (
    <div className="core-connections">
      {view !== 'list' ? (
        <Button
          className="connection-back"
          disabled={state.switching}
          onClick={() => navigate('list')}
        >
          <ArrowLeft size={16} />
          返回 Core 列表
        </Button>
      ) : null}
      {view === 'list' ? (
        <>
          <p className="connection-intro">不同主机分别配对并保持连接，总览同时显示全部主机的数据</p>
          <div className="saved-core-list">
            {[...groups].map(([id, endpoints]) => {
              const current = id === state.endpoint?.serverId;
              const host = hosts.find((host) => host.id === id);
              const endpoint = host?.state.endpoint || endpoints[0];
              const open = expanded === id;
              return (
                <section className="saved-core" data-current={current || undefined} key={id}>
                  <div className="saved-core-heading">
                    <span className="saved-core-icon">
                      <Monitor size={20} />
                    </span>
                    <div className="saved-core-title">
                      <strong>
                        {coreName(id) ||
                          (current && currentName
                            ? currentName
                            : host
                              ? hostName(host.state)
                              : addressName(endpoint))}
                      </strong>
                      <small>
                        {current
                          ? state.online
                            ? '当前 Core · 已连接'
                            : state.connecting
                              ? '当前 Core · 正在重连'
                              : '当前 Core · 离线缓存'
                          : host?.state.online
                            ? '已配对 · 在线'
                            : host?.state.pairingRequired
                              ? '已配对 · 需要重新授权'
                              : host?.state.connecting
                                ? '已配对 · 正在连接'
                                : '已配对 · 离线'}
                      </small>
                    </div>
                    <Button
                      className="icon-button"
                      aria-label={
                        '重命名 Core ' +
                        (coreName(id) || (host ? hostName(host.state) : addressName(endpoint)))
                      }
                      disabled={state.switching}
                      onClick={() => {
                        setRenaming(renaming === id ? '' : id);
                        setName(coreName(id) || '');
                      }}
                    >
                      <Pencil size={16} />
                    </Button>
                    {(current && state.pairingRequired) || host?.state.pairingRequired ? (
                      <Button
                        className="secondary"
                        disabled={state.switching}
                        onClick={() => {
                          setTarget(endpoint);
                          navigate('repair');
                        }}
                      >
                        重新配对
                      </Button>
                    ) : current && state.online ? (
                      <span className="core-current">
                        <Check size={15} />
                        当前
                      </span>
                    ) : (
                      <Button
                        className="secondary"
                        pending={pending === endpoint.uri}
                        disabled={state.switching}
                        onClick={() => void connect(endpoint)}
                      >
                        {current ? '重新连接' : '切换'}
                      </Button>
                    )}
                  </div>
                  {renaming === id ? (
                    <form
                      className="core-name-form form-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveCoreName(id, name)
                          .then(() => {
                            core.patch({});
                            setRenaming('');
                          })
                          .catch((error) => setError(connectionErrorText(error)));
                      }}
                    >
                      <label>
                        Core 备注名称
                        <input
                          maxLength={40}
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder="例如：家中电脑、远程工作站"
                        />
                      </label>
                      <small>只修改此设备上的显示名称，留空恢复主机名称</small>
                      <Button className="secondary" type="submit">
                        保存名称
                      </Button>
                    </form>
                  ) : null}
                  <Button
                    className="core-address-toggle"
                    aria-expanded={open}
                    aria-controls={'core-addresses-' + id}
                    disabled={state.switching}
                    onClick={() => setExpanded(open ? '' : id)}
                  >
                    <span>{endpoints.length} 个连接地址</span>
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Button>
                  {open ? (
                    <div className="core-addresses" id={'core-addresses-' + id}>
                      {endpoints.map((item) => {
                        const active = current && item.uri === state.endpoint?.uri;
                        return (
                          <div className="core-address" key={item.uri}>
                            <span className="core-address-uri">
                              <Link2 size={15} />
                              <span>{item.uri}</span>
                            </span>
                            {active && state.online ? (
                              <span className="core-current">使用中</span>
                            ) : (
                              <Button
                                className="secondary"
                                aria-label={'连接 ' + item.uri}
                                pending={pending === item.uri}
                                disabled={state.switching}
                                onClick={() => void connect(item)}
                              >
                                连接
                              </Button>
                            )}
                          </div>
                        );
                      })}
                      <Button
                        className="core-add-address"
                        disabled={state.switching}
                        onClick={() => {
                          setTarget(endpoint);
                          setURI('');
                          navigate('address');
                        }}
                      >
                        <Plus size={16} />
                        添加连接地址
                      </Button>
                      <small className="core-pin">
                        <ShieldCheck size={13} />
                        身份指纹 {endpoint.publicKeyHash.slice(0, 12)}…
                      </small>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
          <Button
            className="primary full"
            disabled={state.switching}
            onClick={() => navigate('add')}
          >
            <Plus size={17} />
            添加新 Core
          </Button>
          <Button
            className="connection-guide-link"
            disabled={state.switching}
            onClick={() => navigate('remote')}
          >
            通过 UU 远程连接
            <ArrowUpRight size={16} />
          </Button>
        </>
      ) : view === 'add' || view === 'repair' ? (
        <>
          <h3>{view === 'repair' ? '重新配对 Core' : '添加新 Core'}</h3>
          <p className="connection-intro">
            在另一台电脑打开配对窗口，扫描二维码或填写地址、身份指纹与配对码
          </p>
          {addCore(
            onConnected,
            view === 'repair' ? target || state.endpoint || undefined : undefined,
          )}
        </>
      ) : view === 'address' ? (
        <form className="form-stack" onSubmit={submit}>
          <h3>添加连接地址</h3>
          <p className="connection-intro">
            这是同一台主机的备用地址，会沿用已有身份与配对；连接另一台主机请返回「添加新 Core」
          </p>
          <label>
            HTTPS 地址
            <input
              type="url"
              required
              value={uri}
              onChange={(e) => setURI(e.target.value)}
              placeholder="https://127.0.0.1:19443"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <small>地址必须指向 {addressName(target!)} 对应的 Core</small>
          <Button
            className="primary full"
            type="submit"
            pending={Boolean(pending)}
            disabled={state.switching}
          >
            验证并连接
            <ArrowUpRight size={17} />
          </Button>
          <Button
            className="connection-guide-link"
            type="button"
            disabled={state.switching}
            onClick={() => navigate('remote')}
          >
            查看 UU 端口映射说明
            <ChevronRight size={16} />
          </Button>
        </form>
      ) : (
        <div className="core-remote-guide">
          <h3>通过 UU 远程连接</h3>
          <p className="connection-intro">
            在你手边的电脑建立 TCP 映射，再用这台电脑上的 Panestra 连接远端 Core
          </p>
          <ol>
            <li>远端电脑保持 Panestra Core 运行，可以在设置中转入后台模式</li>
            <li>在手边电脑的 UU 远程中，为远端设备建立端口映射</li>
            <li>
              目标地址填 <code>127.0.0.1</code>，远端端口填 <code>9443</code>，本地端口示例为{' '}
              <code>19443</code>
            </li>
            <li>
              在 Panestra 选择「添加新 Core」，填写远端主机的身份指纹、配对码和{' '}
              <code>https://127.0.0.1:19443</code>
            </li>
          </ol>
          <div className="connection-note">
            <Link2 size={16} />
            <span>
              先确认 UU 中映射显示已启动，再检测本地端口
              <br />
              如果提示端口拒绝，说明这台电脑的映射尚未监听或本地端口填错，此时指纹和配对码尚未参与验证
            </span>
          </div>
          <p>端口请以实际配置为准，HTTPS 与实时同步共用同一个 TCP 映射</p>
          <p>
            首次在这台设备连接时，在远端电脑打开配对窗口获取身份指纹和配对码，并批准请求；同一台已配对的远端主机可直接添加连接地址
          </p>
          <div className="connection-note">
            <ShieldCheck size={16} />
            <span>
              保留 HTTPS 和 Core 身份校验
              <br />
              127.0.0.1 仅指手边这台电脑，其他设备需要自己的可达地址；远程映射不会自动发现 Core
            </span>
          </div>
        </div>
      )}
      {pending ? (
        <p className="connection-progress" role="status">
          正在验证 Core 身份与设备权限…
        </p>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
