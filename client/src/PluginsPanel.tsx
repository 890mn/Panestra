import { useEffect, useState, useSyncExternalStore, useRef } from 'react';
import {
  ArrowRight,
  Plug,
  RefreshCw,
  ShieldCheck,
  Cpu,
  Code2,
  Gauge,
  Wallet,
  AudioLines,
  Network,
  Bot,
  Download,
  Upload,
  Trash2,
  Search,
  X,
  LayoutGrid,
} from 'lucide-react';
import type { Widget, ClashStatus } from '../../packages/protocol/src';
import { core, type InstalledPlugin } from './core';
import { widgetCatalog, type PluginManifest, type SettingField } from './plugin-schema';
import { Button, Modal } from './components';
import { connectionErrorText } from './connection-errors';
import { WidgetView } from './WidgetViews';
import { modeName } from './ProxyView';

type Preview = { token: string; manifest: PluginManifest; permissions: Record<string, boolean> };
type Catalog = {
  plugins: Array<{ id: string; name: string; version: string; description?: string }>;
  source: string;
  message?: string;
};
async function marketTask(action: 'catalog' | 'download', id?: string) {
  type Task = {
    token: string;
    state: string;
    error?: string;
    preview?: Preview;
    catalog?: Catalog;
  };
  let task = await core.api<Task>('/plugins/tasks', { action, id });
  const deadline = Date.now() + 190000;
  while (task.state === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    task = await core.api<Task>('/plugins/tasks/' + encodeURIComponent(task.token));
  }
  if (task.state !== 'complete')
    throw { message: task.error || '下载超时，请稍后重新检查插件目录' };
  return task;
}
const icons: Record<string, typeof Plug> = {
  cpu: Cpu,
  code: Code2,
  gauge: Gauge,
  wallet: Wallet,
  audio: AudioLines,
  network: Network,
  bot: Bot,
};
function pluginStatus(plugin: InstalledPlugin, value: unknown, online: boolean) {
  const status = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!online) return { label: 'Core 离线', tone: 'idle', status, live: false };
  if (!plugin.enabled) return { label: '已停用', tone: 'idle', status, live: false };
  if (plugin.status !== 'running')
    return {
      label: plugin.status === 'starting' ? '启动中' : '待授权或启动',
      tone: 'idle',
      status,
      live: false,
    };
  if (status.enabled === false) return { label: '未启用', tone: 'idle', status, live: false };
  if (status.stale) return { label: '数据过期', tone: 'attention', status, live: true };
  if (typeof status.enabled !== 'boolean')
    return { label: '运行中', tone: 'ready', status, live: true };
  const label =
    {
      ready: '已接入',
      connecting: '正在连接',
      needs_login: '需要登录',
      needs_credential: '需要凭据',
      bridge_required: '等待桥接启动',
      not_found: '未找到服务',
    }[String(status.state)] || '暂不可用';
  return {
    label,
    tone:
      status.state === 'ready' ? 'ready' : status.state === 'unavailable' ? 'attention' : 'idle',
    status,
    live: status.state === 'ready',
  };
}
function PluginPreview({
  plugin,
  expanded = false,
}: {
  plugin: InstalledPlugin;
  expanded?: boolean;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const definition = plugin.manifest.widgets[0];
  if (!definition) return null;
  const widget = {
    ...definition.defaults,
    pluginId: plugin.id,
    type: definition.id,
    source: definition.defaults.source || definition.subscriptions[0],
    title: definition.defaults.title || plugin.name,
  } as Widget;
  const topic = plugin.id + '/' + widget.source;
  const data = state.telemetry[topic]?.value;
  return (
    <div className={`plugin-live-preview ${expanded ? 'expanded' : ''}`}>
      <WidgetView
        widget={widget}
        data={data}
        online={state.online && plugin.enabled}
        expanded={expanded}
        history={state.history[topic] || []}
        rxHistory={
          state.history[plugin.id + '/network.rx'] || state.history[topic + '/download'] || []
        }
        txHistory={
          state.history[plugin.id + '/network.tx'] || state.history[topic + '/upload'] || []
        }
        download={state.telemetry[plugin.id + '/network.rx']?.value as number | undefined}
        upload={state.telemetry[plugin.id + '/network.tx']?.value as number | undefined}
      />
    </div>
  );
}
function PluginCard({
  plugin,
  notify,
}: {
  plugin: InstalledPlugin;
  notify: (text: string) => void;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const ui = plugin.manifest.ui || {};
  const Icon = icons[ui.icon || ''] || Plug;
  const topic = plugin.id + '/' + plugin.manifest.sources[0]?.id;
  const { status, label, tone, live } = pluginStatus(
    plugin,
    state.telemetry[topic]?.value,
    state.online,
  );
  const [detail, setDetail] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean | number>>({});
  const [setup, setSetup] = useState<Record<string, unknown>>({});
  const [grants, setGrants] = useState(plugin.permissions);
  const [confirm, setConfirm] = useState(false);
  const owner = state.device?.role === 'owner';
  const fieldValues = (
    field: SettingField,
    context: Record<string, unknown>,
  ): string | boolean | number =>
    field.type === 'secret'
      ? ''
      : field.type === 'boolean'
        ? Boolean(context[field.status || field.setup || field.key])
        : String(context[field.status || field.setup || field.key] ?? '');
  const open = async () => {
    setDetail(true);
    setError('');
    setGrants(plugin.permissions);
    let current: Record<string, unknown> = {};
    if (owner && ui.setup) {
      try {
        current = await core.pluginRequest(plugin.id, 'setup');
        setSetup(current);
      } catch (err) {
        setError(connectionErrorText(err));
      }
    }
    setValues(
      Object.fromEntries(
        (ui.settings || []).map((field) => [
          field.key,
          fieldValues(field, field.setup ? current : status),
        ]),
      ),
    );
  };
  const request = async (operation: string, body: unknown = {}) => {
    setBusy(true);
    setError('');
    try {
      await core.pluginRequest(plugin.id, operation, body);
      setValues((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => [
            key,
            ui.settings?.find((field) => field.key === key)?.type === 'secret' ? '' : value,
          ]),
        ),
      );
      if (owner && ui.setup && operation !== 'refresh')
        setSetup(await core.pluginRequest(plugin.id, 'setup'));
      await core.loadPlugins();
    } catch (err) {
      setError(connectionErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const config = (enabled?: boolean) =>
    Object.fromEntries([
      ...(enabled === undefined ? [] : [['enabled', enabled]]),
      ...(ui.settings || [])
        .filter((field) => field.type !== 'secret' || String(values[field.key] || '').trim())
        .map((field) => [
          field.key,
          field.type === 'integer' ? Number(values[field.key]) : values[field.key],
        ]),
    ]);
  const management = async (action: 'state' | 'uninstall', enabled?: boolean) => {
    setBusy(true);
    setError('');
    try {
      await core.api(
        `/plugins/${encodeURIComponent(plugin.id)}/${action}`,
        action === 'state' ? { enabled, grants: configurable ? {} : grants } : {},
      );
      await core.loadPlugins();
      await core.openRealtime();
      if (action === 'uninstall') setDetail(false);
      notify(
        action === 'uninstall'
          ? '插件已卸载，配置与布局保留'
          : enabled
            ? '插件已启用'
            : '插件已停用',
      );
    } catch (err) {
      setError(connectionErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const configurable = plugin.manifest.routes?.some((route) => route.operation === 'configure');
  const refreshable = plugin.manifest.routes?.some((route) => route.operation === 'refresh');
  const roleCanControl = state.online && ['owner', 'operator'].includes(state.device?.role || '');
  return (
    <article
      className="adapter-card panel"
      data-testid={`${ui.key || plugin.id}-adapter`}
      data-state={tone}
    >
      <div className="adapter-card-heading">
        <span className="adapter-icon">
          <Icon size={22} />
        </span>
        <div className="plugin-card-title">
          <h3>{plugin.name}</h3>
          <span className="adapter-subtitle">{ui.subtitle || '本机插件'}</span>
        </div>
        <span className="adapter-state" data-tone={tone}>
          <span className={`status-light ${tone === 'ready' ? '' : 'offline'}`} />
          {label}
        </span>
      </div>
      <p className="plugin-card-description">{ui.description || '查看此插件的状态与设置'}</p>
      <div className="plugin-card-preview">
        {live || (!state.online && plugin.enabled && state.telemetry[topic]) ? (
          <PluginPreview plugin={plugin} />
        ) : (
          <div className="plugin-preview-empty">
            <Icon size={28} strokeWidth={1.5} aria-hidden="true" />
            <strong>{label}</strong>
            <p>
              {!state.online
                ? '连接 Core 后更新状态'
                : !plugin.enabled || status.enabled === false
                  ? '在状态与设置中启用读取'
                  : typeof status.message === 'string' && status.message
                    ? status.message
                    : '在状态与设置中检查连接和权限'}
            </p>
          </div>
        )}
      </div>
      <div className="plugin-card-footer">
        <div className="plugin-card-meta">
          <span className="mono">v{plugin.version}</span>
          <span>
            <LayoutGrid size={13} />
            {widgetCatalog([plugin]).length} 个组件
          </span>
        </div>
        <Button
          className="secondary"
          aria-label={`查看${plugin.name}${ui.detailLabel || '状态与设置'}`}
          onClick={() => void open()}
        >
          {ui.detailLabel || '状态与设置'}
          <ArrowRight size={16} />
        </Button>
      </div>
      {detail ? (
        <Modal
          title={`${plugin.name} · ${ui.subtitle || '插件设置'}`}
          close={() => {
            setDetail(false);
            setValues({});
            setError('');
          }}
          wide
        >
          <PluginPreview plugin={plugin} expanded />
          {typeof status.message === 'string' ? (
            <p className="subtle" role="status">
              {status.message}
            </p>
          ) : null}
          {ui.controls ? (
            <p className="control-permission-note">
              {status.allowControl
                ? ui.controls.enabledMessage || '已授权控制'
                : ui.controls.readOnlyMessage || '当前只读取状态'}
            </p>
          ) : null}
          {ui.notes?.map((note) => (
            <p className="subtle" key={note}>
              {note}
            </p>
          ))}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {ui.controls?.kind === 'proxy' ? (
            <div className="proxy-control-fields">
              <div className="button-row" role="group" aria-label="代理模式">
                {['rule', 'global', 'direct'].map((mode) => (
                  <Button
                    key={mode}
                    className="status-button"
                    selected={status.mode === mode}
                    disabled={
                      !roleCanControl || busy || !status.allowControl || status.stale === true
                    }
                    onClick={() => void request(ui.controls!.operation, { action: 'mode', mode })}
                  >
                    {modeName(mode)}
                  </Button>
                ))}
              </div>
              {(status as unknown as ClashStatus).groups?.map((group) => (
                <label key={group.name}>
                  {group.name}
                  <select
                    aria-label={`${group.name}节点`}
                    value={group.current}
                    disabled={
                      !group.selectable ||
                      !roleCanControl ||
                      busy ||
                      !status.allowControl ||
                      status.stale === true
                    }
                    onChange={(event) =>
                      void request(ui.controls!.operation, {
                        action: 'node',
                        group: group.name,
                        node: event.target.value,
                      })
                    }
                  >
                    {group.options.map((node) => (
                      <option key={node}>{node}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}
          {owner && configurable ? (
            <form
              className="account-configuration"
              onSubmit={(event) => {
                event.preventDefault();
                void request('configure', config(true));
              }}
            >
              <h3>连接与读取</h3>
              <div className="plugin-settings-fields">
                {(ui.settings || []).map((field) => (
                  <label
                    key={field.key}
                    className={field.type === 'boolean' ? 'plugin-setting-toggle' : ''}
                  >
                    {field.label}
                    <input
                      aria-label={`${plugin.name} ${field.label}`}
                      type={
                        field.type === 'secret'
                          ? 'password'
                          : field.type === 'boolean'
                            ? 'checkbox'
                            : field.type === 'integer'
                              ? 'number'
                              : 'text'
                      }
                      autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
                      disabled={!state.online || busy}
                      {...(field.type === 'boolean'
                        ? { checked: Boolean(values[field.key]) }
                        : { value: String(values[field.key] ?? '') })}
                      min={field.min}
                      max={field.max}
                      maxLength={field.type === 'secret' ? 4096 : 1024}
                      placeholder={
                        field.placeholder ||
                        (field.type === 'secret' && status.hasCredential
                          ? '已保存，留空沿用当前凭据'
                          : '')
                      }
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]:
                            field.type === 'boolean' ? event.target.checked : event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="button-row">
                {ui.ownerActions?.map((action) => (
                  <Button
                    key={action.label}
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request(action.operation, action.body)}
                  >
                    {action.label}
                  </Button>
                ))}
                <Button className="primary" type="submit" pending={busy} disabled={!state.online}>
                  {ui.enableLabel || '保存并启用读取'}
                </Button>
                {status.enabled ? (
                  <Button
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('configure', { enabled: false })}
                  >
                    停用读取
                  </Button>
                ) : null}
                {ui.settings?.some((field) => field.type === 'secret') && status.hasCredential ? (
                  <Button
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() => void request('configure', { clearCredential: true })}
                  >
                    忘记凭据
                  </Button>
                ) : null}
                {ui.setup ? (
                  <Button
                    className="secondary"
                    disabled={busy || !state.online}
                    onClick={() =>
                      void request('prepare', config(ui.prepareEnables ? true : undefined))
                    }
                  >
                    {ui.prepareLabel || '生成桥接启动文件'}
                  </Button>
                ) : null}
              </div>
              {typeof setup.launcher === 'string' && setup.launcher ? (
                <div className="adapter-boundary alas-launcher">
                  <code>{setup.launcher}</code>
                  <p>{ui.launcherNote}</p>
                  <Button
                    className="secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(String(setup.launcher))
                        .then(() => notify('启动文件路径已复制'))
                    }
                  >
                    复制路径
                  </Button>
                </div>
              ) : null}
            </form>
          ) : configurable ? (
            <p className="subtle">只有 Owner 可以更改配置与读取权限</p>
          ) : null}
          {refreshable ? (
            <Button
              className="secondary"
              disabled={busy || !state.online || !status.enabled}
              onClick={() => void request('refresh')}
            >
              <RefreshCw size={16} />
              {ui.refreshLabel || '刷新状态'}
            </Button>
          ) : null}
          <details className="plugin-management" open={!configurable}>
            <summary>插件管理与权限</summary>
            {!configurable ? (
              plugin.manifest.permissions.map((permission) => (
                <label className="permission-row" key={permission.id}>
                  <div>
                    <strong>{ui.permissions?.[permission.id]?.label || permission.id}</strong>
                    <span>
                      {ui.permissions?.[permission.id]?.description ||
                        (permission.required ? '必需权限' : '可选权限')}
                    </span>
                  </div>
                  <input
                    aria-label={ui.permissions?.[permission.id]?.label || permission.id}
                    type="checkbox"
                    disabled={!owner || busy || !state.online}
                    checked={grants[permission.id] || false}
                    onChange={(event) =>
                      setGrants((current) => ({
                        ...current,
                        [permission.id]: event.target.checked,
                      }))
                    }
                  />
                </label>
              ))
            ) : (
              <p className="subtle">读取权限由上方配置控制</p>
            )}
            <p className="mono subtle">
              {plugin.id} · {plugin.version} · 重启 {plugin.restarts} 次
            </p>
            <div className="button-row">
              <Button
                className="primary"
                pending={busy}
                disabled={!owner || !state.online}
                onClick={() => void management('state', true)}
              >
                授权并启用
              </Button>
              <Button
                className="secondary"
                disabled={!owner || !state.online || busy}
                onClick={() => void management('state', false)}
              >
                停用插件
              </Button>
              <Button
                className="danger"
                disabled={!owner || !state.online || busy}
                onClick={() => setConfirm(true)}
              >
                <Trash2 size={16} />
                卸载插件
              </Button>
            </div>
          </details>
          {confirm ? (
            <div className="adapter-boundary">
              <p>卸载后停止运行，已有配置和布局保留，可重新安装恢复</p>
              <Button
                className="danger"
                disabled={busy}
                onClick={() => void management('uninstall')}
              >
                确认卸载
              </Button>
              <Button className="secondary" onClick={() => setConfirm(false)}>
                取消
              </Button>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </article>
  );
}
export function PluginsPanel({
  owner,
  online,
  notify,
}: {
  owner: boolean;
  online: boolean;
  notify: (text: string) => void;
}) {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [filter, setFilter] = useState('all'),
    [query, setQuery] = useState(''),
    [catalogOpen, setCatalogOpen] = useState(false),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [preview, setPreview] = useState<Preview | null>(null);
  const [consent, setConsent] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const catalogTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (online) void core.loadPlugins().catch((err) => notify(connectionErrorText(err)));
  }, [online]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      notify(connectionErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const openPreview = (next: Preview) => {
    setCatalogOpen(false);
    setPreview(next);
    setConsent([]);
  };
  const importFiles = async (list: FileList | null) => {
    if (!list) return;
    const selected = Array.from(list),
      zip = selected.find((file) => file.name.endsWith('.zip')),
      metadata = selected.find((file) => file.name.endsWith('.json')),
      sig = selected.find((file) => file.name.endsWith('.sig'));
    if (!zip || !metadata || !sig) throw { message: '请选择同一插件的 ZIP、JSON 与 SIG 三个文件' };
    if (zip.size > 64 * 1024 * 1024 || metadata.size > 64 * 1024 || sig.size > 1024)
      throw { message: '插件文件超出大小限制' };
    // The signed package's manifest determines identity; the filename only selects a catalog entry.
    const localCatalog = await core.api<Catalog>('/plugins/catalog');
    const item = localCatalog.plugins.find(
      (item) => item.id.split('.').at(-1) === zip.name.replace('.zip', ''),
    );
    const signedInfo = JSON.parse(await metadata.text()) as { pluginId?: string };
    const id =
      signedInfo.pluginId ||
      item?.id ||
      (selected.find((file) => file.name.endsWith('.id')) &&
        (await selected.find((file) => file.name.endsWith('.id'))!.text()));
    if (!id) throw { message: '此包不在目录中，请同时选择含插件 ID 的 .id 文件' };
    const metadataText = await metadata.text();
    const begin = await core.api<{ token: string }>('/plugins/uploads', {
      id: id.trim(),
      size: zip.size,
      metadata: metadataText,
      signature: await sig.text(),
    });
    for (let offset = 0; offset < zip.size; offset += 32768) {
      const chunk = new Uint8Array(await zip.slice(offset, offset + 32768).arrayBuffer());
      await core.api('/plugins/uploads/' + encodeURIComponent(begin.token) + '/chunk', {
        offset,
        data: btoa(String.fromCharCode(...chunk)),
      });
    }
    openPreview(
      await core.api<Preview>(
        '/plugins/uploads/' + encodeURIComponent(begin.token) + '/finish',
        {},
      ),
    );
    setImporting(false);
  };
  const search = query.trim().toLocaleLowerCase();
  const visible = state.plugins.filter(
    (plugin) =>
      (filter === 'all' || plugin.manifest.ui?.category === filter) &&
      [plugin.name, plugin.manifest.ui?.subtitle, plugin.manifest.ui?.description]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search),
  );
  const categories = [
    { id: 'all', label: '全部' },
    { id: 'control', label: '控制' },
    { id: 'status', label: '状态' },
  ];
  return (
    <div className="plugins-page">
      <div className="plugins-page-heading">
        <div>
          <div className="eyebrow">YOUR INTEGRATIONS</div>
          <h1>插件</h1>
          <p>连接常用软件，把状态和控制带到每台设备</p>
        </div>
        <div className="button-row">
          <Button
            className="secondary"
            pending={busy}
            disabled={!online}
            onClick={(event) => {
              catalogTrigger.current = event.currentTarget;
              void run(async () => {
                setCatalog((await marketTask('catalog')).catalog!);
                setCatalogOpen(true);
              });
            }}
          >
            <RefreshCw size={16} />
            检查插件更新
          </Button>
          <Button
            className="primary"
            disabled={!online || busy}
            onClick={(event) => {
              catalogTrigger.current = event.currentTarget;
              void run(async () => {
                setCatalog(await core.api<Catalog>('/plugins/catalog'));
                setCatalogOpen(true);
              });
            }}
          >
            <Download size={16} />
            打开插件目录
          </Button>
          <Button
            className="icon-button plugin-import-button"
            aria-label="导入插件包"
            disabled={!owner || !online || busy}
            onClick={() => setImporting(true)}
          >
            <Upload size={16} />
          </Button>
        </div>
      </div>
      <div className="plugins-installed-heading">
        <h2>
          已安装 <span>{state.plugins.length}</span>
        </h2>
        <span className="subtle">
          {state.plugins.filter((p) => p.enabled).length} 项启用 · 在电脑上运行
        </span>
      </div>
      <div className="plugin-library-toolbar">
        <div className="adapter-filter" role="group" aria-label="软件适配筛选">
          {categories.map((item) => (
            <Button
              key={item.id}
              className="status-button"
              selected={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span aria-hidden="true">
                {
                  state.plugins.filter(
                    (p) => item.id === 'all' || p.manifest.ui?.category === item.id,
                  ).length
                }
              </span>
            </Button>
          ))}
        </div>
        <div className="plugin-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索已安装插件"
            placeholder="搜索插件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <Button className="icon-button" aria-label="清空插件搜索" onClick={() => setQuery('')}>
              <X size={16} />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="adapter-grid">
        {visible.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} notify={notify} />
        ))}
      </div>
      {!state.plugins.length ? (
        <div className="plugin-library-empty panel">
          <Plug size={28} />
          <h3>添加第一个插件</h3>
          <p>打开插件目录选择需要的软件，或导入已签名的插件包</p>
        </div>
      ) : !visible.length ? (
        <div className="plugin-library-empty panel">
          <Search size={28} />
          <h3>没有匹配的插件</h3>
          <p>尝试其他关键词，或切换分类</p>
          <Button
            className="secondary"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            查看全部插件
          </Button>
        </div>
      ) : null}
      {catalogOpen && catalog ? (
        <Modal
          title="插件目录"
          close={() => setCatalogOpen(false)}
          returnFocus={catalogTrigger.current}
          wide
        >
          <div className="plugin-catalog-heading">
            <p>选择插件安装到电脑，已安装的插件可独立更新</p>
            <span className="badge">
              {catalog.source === 'local' ? '本地安装包' : 'GitHub 发布'}
            </span>
          </div>
          {catalog.message ? (
            <p className="plugin-catalog-notice" role="status">
              {catalog.message}
            </p>
          ) : null}
          <div className="plugin-catalog-list">
            {catalog.plugins.map((item) => {
              const installed = state.plugins.find((plugin) => plugin.id === item.id);
              const Icon = icons[installed?.manifest.ui?.icon || ''] || Plug;
              return (
                <div className="backup-row plugin-catalog-row" key={item.id}>
                  <span className="adapter-icon">
                    <Icon size={22} />
                  </span>
                  <div className="plugin-catalog-copy">
                    <strong>{item.name}</strong>
                    <span className="mono subtle"> v{item.version}</span>
                    {item.description ? <p>{item.description}</p> : null}
                  </div>
                  <Button
                    className="secondary"
                    pending={busy}
                    disabled={!owner || !online || installed?.version === item.version}
                    onClick={() =>
                      void run(async () => {
                        openPreview((await marketTask('download', item.id)).preview!);
                      })
                    }
                  >
                    {installed
                      ? installed.version === item.version
                        ? '已安装'
                        : '下载更新'
                      : '下载安装'}
                  </Button>
                </div>
              );
            })}
          </div>
          {!catalog.plugins.length ? (
            <div className="plugin-library-empty">
              <Plug size={28} />
              <h3>暂无可下载的插件</h3>
              <p>稍后检查更新，或导入已签名的插件包</p>
            </div>
          ) : null}
          <div className="quiet-note">
            <ShieldCheck size={18} />
            <p>安装前验证签名与权限，更新失败保留当前版本</p>
          </div>
        </Modal>
      ) : null}
      <div className="quiet-note">
        <ShieldCheck size={18} />
        <p>状态与控制分别授权，凭据留在电脑上，已安装的插件可离线运行</p>
      </div>
      {importing ? (
        <Modal title="导入插件包" close={() => setImporting(false)}>
          <p>选择同一插件的 ZIP 安装包、JSON 签名清单与 SIG 签名文件</p>
          <input
            ref={files}
            type="file"
            multiple
            accept=".zip,.json,.sig,.id"
            aria-label="插件包文件"
            disabled={busy}
            onChange={(event) => void run(() => importFiles(event.target.files))}
          />
        </Modal>
      ) : null}
      {preview ? (
        <Modal title={`安装 ${preview.manifest.name}`} close={() => setPreview(null)}>
          <p>{preview.manifest.ui?.description}</p>
          <p className="mono subtle">
            {preview.manifest.id} · {preview.manifest.version}
          </p>
          <p>文件签名已验证，请确认此插件申请的权限</p>
          {preview.manifest.permissions.map((permission) => (
            <label className="permission-row" key={permission.id}>
              <div>
                <strong>
                  {preview.manifest.ui?.permissions?.[permission.id]?.label || permission.id}
                </strong>
                <span>
                  {preview.permissions[permission.id]
                    ? '沿用已授权权限'
                    : permission.required
                      ? '必需权限'
                      : '可选权限，默认关闭'}
                </span>
              </div>
              <input
                type="checkbox"
                disabled={preview.permissions[permission.id]}
                checked={preview.permissions[permission.id] || consent.includes(permission.id)}
                onChange={(event) =>
                  setConsent((current) =>
                    event.target.checked
                      ? [...current, permission.id]
                      : current.filter((cap) => cap !== permission.id),
                  )
                }
              />
            </label>
          ))}
          <Button
            className="primary"
            pending={busy}
            disabled={
              !owner ||
              !online ||
              preview.manifest.permissions.some(
                (permission) =>
                  permission.required &&
                  !preview.permissions[permission.id] &&
                  !consent.includes(permission.id),
              )
            }
            onClick={() =>
              void run(async () => {
                await core.api('/plugins/install', { token: preview.token, consent });
                await core.loadPlugins();
                await core.openRealtime();
                setPreview(null);
                notify('插件已安装');
              })
            }
          >
            确认安装
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}
