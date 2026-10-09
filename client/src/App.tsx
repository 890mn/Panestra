import {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  AudioLines,
  Bot,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronUp,
  Code2,
  Cpu,
  Download,
  Grip,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  PanelLeftClose,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  Plug,
  Plus,
  Radio,
  Redo2,
  RotateCw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  Undo2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  APIError,
  CodexStatus,
  AccountStatus,
  ClashStatus,
  MediaStatus,
  AlasStatus,
  Breakpoint,
  Entity,
  Endpoint,
  Layout,
  Page,
  Plugin,
  SystemInfo,
  Widget,
  WidgetProfile,
} from '../../packages/protocol/src';
import { widgetCatalog } from './plugin-schema';
import {
  COLUMNS,
  clampLayout,
  deriveLayout,
  arrangeLayouts,
  sameGeometry,
  type LayoutRecord,
} from '../../packages/widget-schema/src';
import { core, coreFleet } from './core';
import { hostName, type CoreHost } from './core-fleet';
import {
  canScanPairing,
  discover,
  localCoreInfo,
  native,
  scanPairing,
  probeEndpoint,
  deviceKey,
} from './platform';
import { loopbackEndpoint, parsePairingCode } from './pairing';
import { connectionErrorText } from './connection-errors';
import { Button, ButtonPreview, Modal } from './components';
import { PluginsPanel } from './PluginsPanel';
import { pluginPresets, pluginSources, pluginPresentations } from './plugin-views';
import { WidgetView } from './WidgetViews';
import {
  PRESENTATIONS,
  presetsFor,
  sourcesFor,
  widgetProfile,
  profileKey,
} from '../../packages/widget-schema/src/presentation';
import { LayoutCanvas, type EditorActions } from './LayoutCanvas';
import { Brand, SLOGAN } from './Brand';
import { AppUpdates } from './AppUpdates';
import { DesktopServicePanel } from './DesktopServicePanel';
import { ResizeGrip } from './ResizeGrip';
import { useSidebar } from './useSidebar';
import { PresentationChoices } from './PresentationChoices';
import { CoreConnections } from './CoreConnections';
import { DevicesPanel } from './DevicesPanel';
import { CoreOverview } from './CoreOverview';
import { useTheme, type Theme } from './theme';
import { UranusHorizon, UranusSettings } from './Uranus23';

const iconSize = 18;
const Icon = ({ source, size = iconSize }: { source: string; size?: number }) =>
  source === 'task.status' ? (
    <Bot size={size} />
  ) : source === 'media.status' ? (
    <AudioLines size={size} />
  ) : source === 'account.usage' ? (
    <Code2 size={size} />
  ) : source.startsWith('cpu') ? (
    <Cpu size={size} />
  ) : source.startsWith('memory') ? (
    <Activity size={size} />
  ) : source.startsWith('disk') ? (
    <HardDrive size={size} />
  ) : (
    <Network size={size} />
  );
const errorText = connectionErrorText;
let initialized = false;
export function App() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const hosts = useSyncExternalStore(coreFleet.subscribe, coreFleet.getSnapshot);
  const { theme, setTheme, resolved, toggleTheme } = useTheme();
  const [activePage, setActivePage] = useState('page-overview');
  const [section, setSection] = useState('aggregate');
  const previousHost = useRef<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<Breakpoint | 'auto'>('auto');
  const [width, setWidth] = useState(window.innerWidth);
  const [modal, setModal] = useState('');
  const connectionFocus = useRef<HTMLElement | null>(null);
  const openConnections = () => {
    connectionFocus.current = document.activeElement as HTMLElement;
    setModal('connect');
  };
  const [configuration, setConfiguration] = useState<Entity<Widget> | null>(null);
  const [notice, setNotice] = useState('');
  const sidebar = useSidebar(width < 768);
  const [undo, setUndo] = useState<
    Array<{
      pageId: string;
      breakpoint: Breakpoint;
      entries: Array<{ id: string; before: Layout; after: Layout; rev: number }>;
    }>
  >([]);
  const [redo, setRedo] = useState<typeof undo>([]);
  const [busy, setBusy] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const layoutSavingRef = useRef(false);
  const pages = (state.snapshot?.entities || []).filter(
    (e) => e.kind === 'page' && !e.deleted,
  ) as unknown as Entity<Page>[];
  const currentPage = pages.find((e) => e.id === activePage) || pages[0];
  const workspaceTitle =
    currentPage?.data.title === '总览' ? '主机工作区' : currentPage?.data.title;
  const widgets = (state.snapshot?.entities || []).filter(
    (e) => e.kind === 'widget' && !e.deleted && e.data.pageId === currentPage?.id,
  ) as unknown as Entity<Widget>[];
  const breakpoint: Breakpoint =
    preview === 'auto'
      ? width >= 1200 && !window.matchMedia('(pointer: coarse)').matches
        ? 'desktop'
        : width >= 768
          ? 'tablet'
          : 'mobile'
      : preview;
  const canEdit = state.online && state.device?.role !== 'viewer';
  const owner = state.device?.role === 'owner';
  const notify = (value: string) => {
    setNotice(value);
  };
  useEffect(() => {
    if (!initialized) {
      initialized = true;
      void core.init();
    }
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') coreFleet.resume();
    };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setUndo([]);
    setRedo([]);
    setEditing(false);
    setConfiguration(null);
    setActivePage('page-overview');
    if (previousHost.current && previousHost.current !== state.endpoint?.serverId)
      setSection('workspace');
    previousHost.current = state.endpoint?.serverId;
  }, [state.endpoint?.serverId]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const openHost = async (host: CoreHost) => {
    await perform(async () => {
      if (!host.active && host.state.endpoint) await core.switchEndpoint(host.state.endpoint);
      setSection('workspace');
      setActivePage('page-overview');
    });
  };
  const layoutEntity = (id: string) =>
    state.snapshot?.entities.find(
      (e) => e.kind === 'layout' && e.id === `${id}:${breakpoint}` && !e.deleted,
    ) as unknown as Entity<Layout> | undefined;
  const records: LayoutRecord[] = widgets.map((widget, i) => {
    const entity = layoutEntity(widget.id);
    return {
      layout: entity?.data || deriveLayout(widget.id, breakpoint, i),
      rev: entity?.rev || 0,
    };
  });
  useEffect(() => {
    setUndo([]);
    setRedo([]);
  }, [currentPage?.id, breakpoint]);
  const arrange = async (layouts: Layout[], baseline: LayoutRecord[]) => {
    if (!currentPage || !canEdit || layoutSavingRef.current) return;
    const changes = layouts.filter((next) => {
      const before = baseline.find((r) => r.layout.widgetId === next.widgetId);
      return before && !sameGeometry(before.layout, next);
    });
    if (!changes.length) return;
    layoutSavingRef.current = true;
    setLayoutSaving(true);
    try {
      const event = await core.command({ id: currentPage.id, rev: 0 }, 'layout.arrange', {
        breakpoint,
        items: changes.map((layout) => ({
          baseRev: baseline.find((r) => r.layout.widgetId === layout.widgetId)!.rev,
          layout: clampLayout(layout),
        })),
      });
      const entries = (event.entities || [event.entity]).map((entity) => {
        const after = entity.data as unknown as Layout;
        return {
          id: entity.id,
          before: baseline.find((r) => r.layout.widgetId === after.widgetId)!.layout,
          after,
          rev: entity.rev,
        };
      });
      setUndo((list) => [...list.slice(-39), { pageId: currentPage.id, breakpoint, entries }]);
      setRedo([]);
    } catch (e) {
      notify(errorText(e));
      try {
        const snapshot =
          await core.api<import('../../packages/protocol/src').Snapshot>('/snapshot');
        core.patch({ snapshot });
        core.cache();
      } catch {}
      throw e;
    } finally {
      layoutSavingRef.current = false;
      setLayoutSaving(false);
    }
  };
  const commitLayout = async (_widget: Entity<Widget>, next: Layout) => {
    await arrange(
      arrangeLayouts(
        records.map((r) => r.layout),
        clampLayout(next),
      ),
      records,
    );
  };
  const history = async (direction: 'undo' | 'redo') => {
    const list = direction === 'undo' ? undo : redo;
    const item = list.at(-1);
    if (!item || layoutSavingRef.current) return;
    const latest = core.state.snapshot?.entities || [];
    if (
      item.entries.some((entry) => {
        const entity = latest.find((e) => e.kind === 'layout' && e.id === entry.id);
        return !entity || entity.deleted || entity.rev !== entry.rev;
      })
    ) {
      notify('这组布局已被另一块屏幕修改，不能覆盖新的布局');
      setUndo([]);
      setRedo([]);
      return;
    }
    layoutSavingRef.current = true;
    setLayoutSaving(true);
    try {
      const result = await core.command({ id: item.pageId, rev: 0 }, 'layout.arrange', {
        breakpoint: item.breakpoint,
        items: item.entries.map((entry) => ({
          baseRev: entry.rev,
          layout: clampLayout(direction === 'undo' ? entry.before : entry.after),
        })),
      });
      const entities = result.entities || [result.entity];
      const next = {
        ...item,
        entries: item.entries.map((entry) => ({
          ...entry,
          rev: entities.find((e) => e.id === entry.id)!.rev,
        })),
      };
      if (direction === 'undo') {
        setUndo((v) => v.slice(0, -1));
        setRedo((v) => [...v, next]);
      } else {
        setRedo((v) => v.slice(0, -1));
        setUndo((v) => [...v, next]);
      }
    } catch (e) {
      notify(errorText(e));
    } finally {
      layoutSavingRef.current = false;
      setLayoutSaving(false);
    }
  };
  const addWidget = async (
    source: string,
    type: Widget['type'],
    title: string,
    pluginId: string,
    unit: string,
    color: string,
  ) => {
    if (!currentPage) return;
    const id = 'widget-' + crypto.randomUUID();
    await core.command({ id, rev: 0 }, 'widget.create', {
      pageId: currentPage.id,
      pluginId,
      type,
      title,
      source,
      unit,
      color,
    });
    for (const bp of ['desktop', 'tablet', 'mobile'] as Breakpoint[]) {
      const layouts =
        core.state.snapshot?.entities.filter(
          (e) => e.kind === 'layout' && !e.deleted && e.data.breakpoint === bp,
        ) || [];
      const bottom = Math.max(
        0,
        ...layouts
          .filter((l) => widgets.some((w) => w.id === l.data.widgetId))
          .map((l) => Number(l.data.y) + Number(l.data.h)),
      );
      await core.command({ id: `${id}:${bp}`, rev: 0 }, 'layout.commit', {
        ...deriveLayout(id, bp, 0),
        h: type === 'codex-usage' ? 4 : 3,
        y: bottom,
      });
    }
    setModal('');
    notify('组件已添加，其他在线设备 会同步更新');
  };
  const systemPlugin = state.plugins.find((plugin) =>
    plugin.manifest.sources.some((source) => source.id === 'system.info'),
  );
  const system = state.telemetry[`${systemPlugin?.id}/system.info`]?.value as
    SystemInfo | undefined;
  const connectionDialog =
    modal === 'connect' || modal === 'repair' ? (
      <Modal
        title="Core 连接"
        returnFocus={connectionFocus.current}
        close={() => {
          if (!state.switching) setModal('');
        }}
      >
        <CoreConnections
          currentName={system?.hostname}
          repairing={modal === 'repair'}
          addCore={(done, endpoint) => (
            <ConnectForm adding initialEndpoint={endpoint} onSuccess={done} />
          )}
          onConnected={() => {
            setModal('');
            notify('Core 已连接');
          }}
        />
      </Modal>
    ) : null;
  if (!state.snapshot && !state.device && !state.endpoint)
    return (
      <>
        <ConnectScreen
          night={resolved === 'night'}
          manageCores={state.knownEndpoints.length ? openConnections : undefined}
          toggleTheme={toggleTheme}
        />
        {connectionDialog}
        {notice ? (
          <div role="status" className="toast">
            {notice}
          </div>
        ) : null}
      </>
    );

  return (
    <div className={`app-shell ${sidebar.visible ? '' : 'sidebar-collapsed'}`}>
      <aside
        id="main-navigation"
        aria-label="主导航"
        className={`sidebar ${sidebar.visible ? 'open' : ''}`}
        inert={!sidebar.visible}
        {...sidebar.bindings}
      >
        <div className="brand">
          <Brand slogan onError={(error) => notify(errorText(error))} />
        </div>
        <div className="nav-label">
          工作空间{' '}
          <Button
            disabled={!canEdit}
            className="icon-button small"
            aria-label="添加页面"
            onClick={() => setModal('page')}
          >
            <Plus size={15} />
          </Button>
        </div>
        <nav aria-label="页面">
          <Button
            className={`nav-item ${section === 'aggregate' ? 'active' : ''}`}
            onClick={() => {
              setSection('aggregate');
              setEditing(false);
              sidebar.dismissMobile();
            }}
          >
            <LayoutDashboard size={18} />
            <span>总览</span>
            {section === 'aggregate' ? <span className="active-dot" /> : null}
          </Button>
          {pages.map((page) => (
            <Button
              key={page.id}
              className={
                section === 'workspace' && currentPage?.id === page.id
                  ? 'nav-item active'
                  : 'nav-item'
              }
              onClick={() => {
                setActivePage(page.id);
                setSection('workspace');
                sidebar.dismissMobile();
              }}
            >
              <LayoutDashboard size={18} />
              <span>{page.data.title === '总览' ? '主机工作区' : page.data.title}</span>
              {section === 'workspace' && currentPage?.id === page.id ? (
                <span className="active-dot" />
              ) : null}
            </Button>
          ))}
        </nav>
        <div className="nav-label spaced">管理</div>
        <nav aria-label="管理">
          {[
            { id: 'plugins', title: '插件', icon: <Plug size={18} /> },
            { id: 'devices', title: '设备与连接', icon: <Monitor size={18} /> },
            { id: 'settings', title: '设置', icon: <Settings2 size={18} /> },
          ].map((item) => (
            <Button
              key={item.id}
              className={`nav-item ${section === item.id ? 'active' : ''}`}
              onClick={() => {
                setSection(item.id);
                sidebar.dismissMobile();
              }}
            >
              {item.icon}
              <span>{item.title}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            className="core-status"
            aria-label="管理 Core 连接"
            aria-haspopup="dialog"
            aria-expanded={modal === 'connect' || modal === 'repair'}
            onClick={openConnections}
          >
            <span className={`status-light ${state.online ? '' : 'offline'}`} />
            <div>
              <strong>{system?.hostname || hostName(state)}</strong>
              <small>
                {state.online
                  ? '已连接 · HTTPS / WSS'
                  : state.connecting
                    ? '正在重连 · 缓存只读'
                    : '离线 · 缓存只读'}
              </small>
            </div>
            <ChevronUp size={17} />
          </Button>
        </div>
      </aside>
      {sidebar.visible && width < 768 ? (
        <Button className="sidebar-backdrop" aria-label="关闭菜单" onClick={sidebar.close} />
      ) : null}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <Button
              ref={sidebar.toggle}
              className="icon-button sidebar-toggle"
              aria-label={sidebar.visible && width >= 768 ? '收起侧栏' : '打开菜单'}
              aria-controls="main-navigation"
              aria-expanded={sidebar.visible}
              onClick={sidebar.visible ? sidebar.close : sidebar.open}
            >
              {sidebar.visible && width >= 768 ? <PanelLeftClose size={20} /> : <Menu size={20} />}
            </Button>
            <span className="topbar-context-icon">
              {section === 'workspace' || section === 'aggregate' ? (
                <LayoutDashboard size={18} />
              ) : section === 'plugins' ? (
                <Plug size={18} />
              ) : section === 'devices' ? (
                <Monitor size={18} />
              ) : (
                <Settings2 size={18} />
              )}
            </span>
            <strong>
              {section === 'aggregate'
                ? '总览'
                : section === 'workspace'
                  ? workspaceTitle
                  : section === 'plugins'
                    ? '插件'
                    : section === 'devices'
                      ? '设备与连接'
                      : '设置'}
            </strong>
            <span className="topbar-mode">
              {section === 'aggregate'
                ? '全部主机'
                : section === 'workspace'
                  ? editing
                    ? '布局编辑'
                    : hostName(state)
                  : '管理'}
            </span>
          </div>
          <div className="topbar-right">
            <span className="live-pill">
              <span
                className={`status-light ${(section === 'aggregate' ? hosts.some((host) => host.state.online) : state.online) ? '' : 'offline'}`}
              />
              {section === 'aggregate'
                ? `${hosts.filter((host) => host.state.online).length} / ${hosts.length} 台在线`
                : state.online
                  ? '实时同步'
                  : '离线'}
            </span>
            <span className="separator" />
            <Button
              className="icon-button"
              aria-label={resolved === 'night' ? '切换白昼' : '切换黑夜'}
              onClick={toggleTheme}
            >
              {resolved === 'night' ? <Sun size={19} /> : <Moon size={19} />}
            </Button>
          </div>
        </header>
        <main>
          <UranusHorizon />
          {!state.online && section !== 'aggregate' ? (
            <div className="offline-banner" role="status">
              <WifiOff size={18} />
              <span>{state.error || '正在重新连接 Core，离线期间只读，操作不会排队'}</span>
              {!state.pairingRequired ? (
                <Button
                  className="secondary"
                  pending={state.connecting || busy}
                  onClick={() => void perform(() => core.login())}
                >
                  重新连接
                </Button>
              ) : null}
              <Button
                className="secondary"
                onClick={() => {
                  openConnections();
                  if (state.pairingRequired) setModal('repair');
                }}
              >
                {state.pairingRequired ? '重新配对' : '连接其他 Core'}
              </Button>
            </div>
          ) : null}
          {section === 'aggregate' ? (
            <CoreOverview
              breakpoint={breakpoint}
              openHost={(host) => void openHost(host)}
              manage={openConnections}
            />
          ) : null}
          {section === 'workspace' ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR PERSONAL CONTROL PLANE</div>
                  <h1>{workspaceTitle || '工作空间'}</h1>
                  <p>一个核心，让每块屏幕各得其所</p>
                </div>
                <div className="surface-orbit" title="同一工作空间支持不同屏幕">
                  <span>
                    <Monitor size={19} />
                  </span>
                  <div className="orbit-line" />
                  <span>
                    <Tablet size={18} />
                  </span>
                  <div className="orbit-line" />
                  <span>
                    <Smartphone size={17} />
                  </span>
                  <small>{SLOGAN}</small>
                </div>
              </div>
              <div className="workspace-toolbar">
                <div className="toolbar-tabs">
                  <Button
                    selected={!editing}
                    className={!editing ? 'selected' : ''}
                    onClick={() => setEditing(false)}
                  >
                    <LayoutDashboard size={16} />
                    浏览
                  </Button>
                  <Button
                    selected={editing}
                    disabled={!canEdit}
                    className={editing ? 'selected' : ''}
                    onClick={() => setEditing(true)}
                  >
                    <Settings2 size={16} />
                    编辑布局
                  </Button>
                </div>
                <div className="toolbar-actions">
                  <span className="subtle toolbar-caption">
                    {widgets.length} 个组件 <span>·</span>{' '}
                    {breakpoint === 'desktop' ? '桌面' : breakpoint === 'tablet' ? '平板' : '手机'}
                    视图
                  </span>
                  <Button
                    className="primary compact"
                    disabled={!canEdit || busy}
                    onClick={() => setModal('widget')}
                  >
                    <Plus size={17} />
                    添加组件
                  </Button>
                </div>
              </div>
              <LayoutCanvas
                key={currentPage?.id + ':' + breakpoint}
                widgets={widgets}
                records={records}
                breakpoint={breakpoint}
                previewMode={preview}
                editing={editing && canEdit}
                saving={layoutSaving}
                commit={arrange}
                saveProfile={async (widget, key, profile) => {
                  await core.command(widget, 'widget.update', {
                    sizeProfiles: { ...widget.data.sizeProfiles, [key]: profile },
                  });
                }}
                configure={setConfiguration}
                historyActions={
                  <>
                    {' '}
                    <Button
                      className="icon-button"
                      aria-label="撤销布局"
                      disabled={!undo.length || busy || layoutSaving}
                      onClick={() => void perform(() => history('undo'))}
                    >
                      <Undo2 size={17} />
                    </Button>
                    <Button
                      className="icon-button"
                      aria-label="重做布局"
                      disabled={!redo.length || busy || layoutSaving}
                      onClick={() => void perform(() => history('redo'))}
                    >
                      <Redo2 size={17} />
                    </Button>
                  </>
                }
                toolbar={
                  <>
                    <select
                      aria-label="布局断点"
                      value={preview}
                      onChange={(e) => setPreview(e.target.value as Breakpoint | 'auto')}
                    >
                      <option value="auto">当前屏幕</option>
                      <option value="desktop">桌面 · 12 列</option>
                      <option value="tablet">平板 · 8 列</option>
                      <option value="mobile">手机 · 4 列</option>
                    </select>
                    <Button
                      className="icon-button"
                      aria-label="页面选项"
                      onClick={() => setModal('page-settings')}
                    >
                      <MoreHorizontal size={20} />
                    </Button>
                  </>
                }
                renderCard={(widget, layout, editor) => (
                  <WidgetCard
                    key={widget.id}
                    widget={widget}
                    layout={layout}
                    editor={editor}
                    editing={editing && canEdit}
                    data={state.telemetry[`${widget.data.pluginId}/${widget.data.source}`]?.value}
                    download={
                      state.telemetry[`${widget.data.pluginId}/network.rx`]?.value as
                        number | undefined
                    }
                    upload={
                      state.telemetry[`${widget.data.pluginId}/network.tx`]?.value as
                        number | undefined
                    }
                    rxHistory={
                      state.history[
                        widget.data.type === 'proxy-status'
                          ? `${widget.data.pluginId}/${widget.data.source}/download`
                          : `${widget.data.pluginId}/network.rx`
                      ] || []
                    }
                    txHistory={
                      state.history[
                        widget.data.type === 'proxy-status'
                          ? `${widget.data.pluginId}/${widget.data.source}/upload`
                          : `${widget.data.pluginId}/network.tx`
                      ] || []
                    }
                    history={state.history[`${widget.data.pluginId}/${widget.data.source}`] || []}
                    online={state.online}
                    configure={() => setConfiguration(widget)}
                  />
                )}
                empty={
                  <div className="empty-state">
                    <LayoutDashboard size={32} />
                    <h3>这块画布，留给你的日常</h3>
                    <p>添加系统状态组件，开始编排你的工作空间</p>
                    <Button
                      className="primary"
                      disabled={!canEdit}
                      onClick={() => setModal('widget')}
                    >
                      <Plus size={17} />
                      添加第一个组件
                    </Button>
                  </div>
                }
              />
              <div className="workspace-footer">
                <span>
                  <ShieldCheck size={14} />
                  数据留在你的 Core
                </span>
                <span>
                  序列 {state.snapshot?.serverSeq || 0} <span>·</span>{' '}
                  {state.device?.role || '离线缓存'}
                </span>
              </div>
            </>
          ) : null}
          {section === 'plugins' ? (
            <PluginsPanel owner={owner} online={state.online} notify={notify} />
          ) : null}
          {section === 'devices' ? (
            <DevicesPanel
              key={state.endpoint?.serverId}
              owner={owner}
              online={state.online}
              notify={notify}
              onConnect={openConnections}
            />
          ) : null}
          {section === 'settings' ? (
            <SettingsPanel
              theme={theme}
              setTheme={setTheme}
              owner={owner}
              online={state.online}
              notify={notify}
            />
          ) : null}
        </main>
      </div>
      {modal === 'widget' ? (
        <Modal title="添加组件" close={() => setModal('')} wide>
          <p className="modal-description">系统状态、软件信息与常用控制，在每块屏幕同步呈现</p>
          <div className="widget-library">
            {widgetCatalog(state.plugins).map((item) => (
              <Button
                className="library-item"
                disabled={busy}
                key={item.title}
                onClick={() =>
                  void perform(() =>
                    addWidget(
                      item.source,
                      item.type as Widget['type'],
                      item.title,
                      item.pluginId,
                      item.unit || '',
                      item.color || 'sage',
                    ),
                  )
                }
              >
                <span className="widget-icon">
                  <Icon source={item.source} size={23} />
                </span>
                <strong>{item.title}</strong>
                <p>{item.description}</p>
                <span className="library-add">
                  <Plus size={15} />
                  添加
                </span>
              </Button>
            ))}
          </div>
        </Modal>
      ) : null}
      {configuration ? (
        <WidgetConfig
          widget={configuration}
          layout={layoutEntity(configuration.id)}
          close={() => setConfiguration(null)}
          notify={notify}
          commitLayout={(next) => commitLayout(configuration, next)}
          canEdit={canEdit}
        />
      ) : null}
      {modal === 'page' ? (
        <Modal title="新建页面" close={() => setModal('')}>
          <NameForm
            initial=""
            label="页面名称"
            submit={(title) =>
              perform(async () => {
                const event = await core.command(
                  { id: 'page-' + crypto.randomUUID(), rev: 0 },
                  'page.create',
                  { title, workspaceId: 'workspace-main', icon: 'layout' },
                );
                setActivePage(event.entity.id);
                setSection('workspace');
                setModal('');
              })
            }
          />
        </Modal>
      ) : null}
      {modal === 'page-settings' && currentPage ? (
        <Modal title="页面设置" close={() => setModal('')}>
          <NameForm
            initial={currentPage.data.title}
            label="页面名称"
            submit={(title) =>
              perform(async () => {
                await core.command(currentPage, 'page.update', { title });
                setModal('');
              })
            }
          />
          <div className="danger-zone">
            <p>删除页面将同时删除其中的组件</p>
            <Button
              className="danger"
              disabled={pages.length <= 1 || busy}
              onClick={() =>
                void perform(async () => {
                  await core.command(currentPage, 'page.delete', {});
                  setModal('');
                })
              }
            >
              <Trash2 size={16} />
              删除此页面
            </Button>
          </div>
        </Modal>
      ) : null}
      {connectionDialog}
      {notice ? (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <Button className="icon-button" aria-label="关闭通知" onClick={() => setNotice('')}>
            <X size={16} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectScreen({
  night,
  toggleTheme,
  manageCores,
}: {
  night: boolean;
  toggleTheme: () => void;
  manageCores?: () => void;
}) {
  return (
    <div className="connect-screen">
      <header>
        <div className="brand">
          <Brand showVersion />
        </div>
        <Button className="icon-button" aria-label="切换主题" onClick={toggleTheme}>
          {night ? <Sun size={20} /> : <Moon size={20} />}
        </Button>
      </header>
      <main className="connect-layout">
        <div className="connect-story">
          <div className="eyebrow">
            <span className="status-light" />
            {SLOGAN}
          </div>
          <h1>
            你的世界，
            <br />
            在每一块屏幕上。
          </h1>
          <p>
            让电脑成为核心，让设备成为窗口
            <br />
            状态、布局与控制，汇聚在同一处
          </p>
          <div className="brand-art">
            <img src="/icon-origin.png" alt="Panestra，多块面板围绕同一个核心" />
          </div>
          <div className="connect-footnote">
            <ShieldCheck size={16} />
            本地存储 <span>·</span> 安全配对 <span>·</span> 实时同步
          </div>
        </div>
        <div className="connect-card">
          <span className="step-eyebrow">
            {/Android/.test(navigator.userAgent) ? '连接主机' : '电脑端'}
          </span>
          <h2>从一台电脑开始</h2>
          <p className="modal-description">建立主机或配对此设备</p>
          <ConnectForm />
          {manageCores ? (
            <Button className="secondary full" onClick={manageCores}>
              管理已配对 Core
            </Button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
function ConnectForm({
  onSuccess,
  adding = false,
  initialEndpoint,
}: {
  onSuccess?: () => void;
  adding?: boolean;
  initialEndpoint?: Endpoint;
}) {
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [uri, setURI] = useState(
    adding
      ? initialEndpoint?.uri || ''
      : state.endpoint?.uri ||
          (location.protocol === 'https:' ? location.origin : 'https://localhost:9443'),
  );
  const [fingerprint, setFingerprint] = useState(
    adding ? initialEndpoint?.publicKeyHash || '' : state.endpoint?.publicKeyHash || '',
  );
  const [name, setName] = useState(
    native ? '星序设备' : /Android|iPhone/.test(navigator.userAgent) ? '我的手机' : '我的电脑',
  );
  const [code, setCode] = useState('');
  const [scanned, setScanned] = useState<{ serverId: string; expiresAt: string } | null>(null);
  const [bootstrap, setBootstrap] = useState(
    !adding && !state.endpoint && !/Android/.test(navigator.userAgent),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [connectionTest, setConnectionTest] = useState<{ key: string; text: string } | null>(null);
  const [portTest, setPortTest] = useState<{ uri: string; text: string } | null>(null);
  const testPort = async () => {
    setBusy(true);
    setError('');
    setPortTest(null);
    try {
      await probeEndpoint(uri.trim());
      setPortTest({ uri: uri.trim(), text: '端口已接受连接，下一步核对 Core 身份指纹' });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const connectionTestKey = uri.trim() + '|' + fingerprint.replace(/\s|:/g, '').toLowerCase();
  const testConnection = async () => {
    setError('');
    setPortTest(null);
    setConnectionTest(null);
    setBusy(true);
    try {
      if (native) await probeEndpoint(uri.trim());
      const result = await core.identity(
        uri.trim(),
        fingerprint.replace(/\s|:/g, '').toLowerCase(),
      );
      setConnectionTest({
        key: connectionTestKey,
        text: `已连接并验证 Core 身份 · ID ${result.identity.serverId.slice(0, 8)}`,
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const [candidates, setCandidates] = useState<
    Array<{ uri: string; name: string; serverIdHint?: string }>
  >([]);
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    void deviceKey()
      .then((key) => {
        if (!stopped && key.deviceName)
          setName((current) => (current === '星序设备' ? key.deviceName!.slice(0, 40) : current));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    void discover()
      .then(setCandidates)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!native || adding) return;
    let attempts = 0;
    const timer = setInterval(() => {
      void localCoreInfo().then((info) => {
        if (info?.fingerprint) {
          setURI(info.endpoint);
          setFingerprint(info.fingerprint);
          if (info.bootstrapCode) {
            setCode(info.bootstrapCode);
            setBootstrap(true);
          }
          clearInterval(timer);
        }
      });
      if (++attempts > 15) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [adding]);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await core.pollPair(pending);
        if (stopped) return;
        if (status === 'approved') {
          setPending('');
          onSuccessRef.current?.();
        } else timer = setTimeout(() => void poll(), 3000);
      } catch (e) {
        if (!stopped) {
          setError(errorText(e));
          setPending('');
        }
      }
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);
  const scan = async () => {
    setError('');
    setBusy(true);
    try {
      const text = await scanPairing();
      if (!text) return;
      const value = parsePairingCode(text);
      let endpoint = value.endpoint;
      if (loopbackEndpoint(endpoint)) {
        const candidate = candidates.find(
          (c) => c.serverIdHint === value.serverId && !loopbackEndpoint(c.uri),
        );
        if (candidate) endpoint = candidate.uri;
        else if (
          state.endpoint?.serverId === value.serverId &&
          !loopbackEndpoint(state.endpoint.uri)
        )
          endpoint = state.endpoint.uri;
      }
      setURI(endpoint);
      setFingerprint(value.fingerprint);
      setCode(value.code);
      setBootstrap(false);
      setScanned(value);
      if (loopbackEndpoint(endpoint))
        setError('二维码使用了电脑本机地址，请选择已发现的 Core，或填写电脑的局域网地址');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (scanned && Date.parse(scanned.expiresAt) <= Date.now())
        throw new Error('配对二维码已过期，请在电脑重新点击“添加设备”');
      if (native) await probeEndpoint(uri.trim());
      const id = await core.claim(
        uri.trim(),
        fingerprint.replace(/\s|:/g, '').toLowerCase(),
        code.trim(),
        name,
        bootstrap,
        bootstrap ? undefined : scanned?.serverId,
      );
      if (id) setPending(id);
      else onSuccess?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-stack">
      {adding ? (
        <ol className="connection-steps" aria-label="连接步骤">
          <li data-active={(!pending && connectionTest?.key !== connectionTestKey) || undefined}>
            1 检查地址
          </li>
          <li data-active={(!pending && connectionTest?.key === connectionTestKey) || undefined}>
            2 核对身份
          </li>
          <li data-active={Boolean(pending) || undefined}>3 主机批准</li>
        </ol>
      ) : (
        <div className="segmented">
          <Button
            type="button"
            selected={bootstrap}
            disabled={busy || Boolean(pending)}
            className={bootstrap ? 'selected' : ''}
            onClick={() => setBootstrap(true)}
          >
            建立主机
          </Button>
          <Button
            type="button"
            selected={!bootstrap}
            disabled={busy || Boolean(pending)}
            className={!bootstrap ? 'selected' : ''}
            onClick={() => setBootstrap(false)}
          >
            配对此设备
          </Button>
        </div>
      )}
      {canScanPairing ? (
        <Button
          type="button"
          className="secondary full"
          disabled={busy || Boolean(pending)}
          onClick={() => void scan()}
        >
          <Smartphone size={18} />
          扫描电脑配对二维码
        </Button>
      ) : null}
      {candidates.length ? (
        <div className="discovered">
          <span>
            <Radio size={15} />
            找到可连接的 Core
          </span>
          {candidates.map((c) => (
            <Button key={c.uri} type="button" onClick={() => setURI(c.uri)}>
              <Monitor size={16} />
              <strong>{c.name}</strong>
              <small>{c.uri}</small>
            </Button>
          ))}
        </div>
      ) : null}
      <label>
        Core 地址
        <input
          aria-label="Core 地址"
          required
          type="url"
          value={uri}
          onChange={(e) => setURI(e.target.value)}
          placeholder="https://192.168.1.10:9443"
        />
        {adding ? (
          <small className="connection-address-note">
            {loopbackEndpoint(uri)
              ? '127.0.0.1 / localhost 指当前设备，连接远端主机必须先在当前设备启动相应的端口映射'
              : '局域网填写目标电脑的 IP 与 Core 端口；远程连接填写映射服务在当前设备提供的地址'}
          </small>
        ) : null}
      </label>
      {native && adding ? (
        <>
          <Button
            type="button"
            className="secondary full"
            disabled={busy || Boolean(pending) || !uri.trim()}
            onClick={() => void testPort()}
          >
            <Wifi size={17} />
            检测地址端口
          </Button>
          {portTest?.uri === uri.trim() ? (
            <div className="connection-test-result" role="status">
              {portTest.text}
              <small>端口可达不代表是正确 Core，后续仍须验证 SHA-256</small>
            </div>
          ) : null}
        </>
      ) : null}
      <label>
        Core 身份指纹
        <input
          className="mono fingerprint-input"
          required
          value={fingerprint}
          onChange={(e) => setFingerprint(e.target.value)}
          placeholder="本机 Core 显示的 SHA-256 指纹"
          spellCheck={false}
        />
        <small>复制目标主机「设备与连接」显示的完整 SHA-256，发现结果仅提供地址</small>
      </label>
      <div className="form-row">
        <label>
          {bootstrap ? '首次认领码' : '配对码'}
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            placeholder={bootstrap ? '在启动终端查看' : '在电脑端打开配对窗口'}
          />
        </label>
        <label>
          此设备名称
          <input
            aria-label="此设备名称"
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {adding ? <small>目标 Core 将用这个名称显示当前设备</small> : null}
        </label>
      </div>
      <Button
        type="button"
        className="secondary full"
        disabled={busy || Boolean(pending) || !uri.trim() || !fingerprint.trim()}
        onClick={() => void testConnection()}
      >
        <Wifi size={17} />
        测试连接
      </Button>
      {connectionTest?.key === connectionTestKey ? (
        <div className="connection-test-result" role="status">
          {connectionTest.text}
          <small>仅验证地址与身份，不提交配对请求</small>
        </div>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {pending ? (
        <div className="waiting">
          <Radio size={18} />
          等待 Core 本机确认，请核对设备名称与指纹
        </div>
      ) : (
        <Button className="primary full" pending={busy} type="submit">
          {busy ? '正在验证身份…' : bootstrap ? '建立并进入工作空间' : '发送配对请求'}
          <ArrowUpRight size={18} />
        </Button>
      )}
      <p className="connection-hint">
        <LockKeyhole size={13} />
        {native
          ? '私钥保存在系统安全存储中，TLS 校验绑定到 Core 指纹'
          : '浏览器需要先信任 Core 的本地证书；原生客户端自动校验固定指纹'}
      </p>
      {!native ? (
        <a className="certificate-link" href={uri} target="_blank" rel="noreferrer">
          打开 Core 地址，检查本地证书 ↗
        </a>
      ) : null}
    </form>
  );
}
export const WidgetCard = memo(function WidgetCard(props: {
  widget: Entity<Widget>;
  layout: Layout;
  editor: EditorActions;
  editing: boolean;
  data?: number | SystemInfo | CodexStatus | AccountStatus | ClashStatus | MediaStatus | AlasStatus;
  download?: number;
  upload?: number;
  history: number[];
  rxHistory: number[];
  txHistory: number[];
  online: boolean;
  configure: () => void;
}) {
  const { widget, layout: l, editor, editing, configure } = props;
  const cols = COLUMNS[l.breakpoint];
  const gap = 16;
  const [detail, setDetail] = useState(false);
  const view = {
    ...props,
    widget: widget.data,
    profile: editor.profile || widgetProfile(widget.data, l),
    contentEditor: editing ? editor.contentEditor : undefined,
  };
  const left = `calc(${(l.x / cols) * 100}% + ${(l.x * gap) / cols}px)`;
  const width = `calc(${(l.w / cols) * 100}% - ${gap * (1 - l.w / cols)}px)`;
  return (
    <>
      <article
        {...(editing ? editor.surface : {})}
        className={`widget-card ${editing ? 'editable' : ''} ${editor.dragging ? 'dragging' : ''} ${editing && editor.selected ? 'layout-selected' : ''} ${editing && editor.target ? 'layout-target' : ''}`}
        data-widget-type={widget.data.type}
        style={{ left, top: l.y * 84, width, height: l.h * 84 - 16 }}
        data-testid={widget.id}
      >
        <div className="widget-heading">
          <div className="widget-title">
            <span className="widget-icon">
              <Icon source={widget.data.source} />
            </span>
            <button
              className="widget-detail-trigger"
              aria-label={editing ? `选择${widget.data.title}` : `查看${widget.data.title}详情`}
              onClick={editing ? editor.select : () => setDetail(true)}
            >
              <h3 title={widget.data.title}>{widget.data.title}</h3>
            </button>
          </div>
          <div className="widget-controls">
            {editing ? (
              <Button
                className="layout-move layout-title-move icon-button"
                aria-label={`拖动${widget.data.title}`}
                {...editor.move}
              >
                <Grip className="title-grip" size={18} />
              </Button>
            ) : (
              <Button
                className="icon-button"
                aria-label={`配置${widget.data.title}`}
                onClick={configure}
              >
                <MoreHorizontal size={18} />
              </Button>
            )}
          </div>
        </div>
        <div className="widget-content">
          <WidgetView {...view} />
        </div>
        {editing ? (
          <Button
            className="layout-resize layout-corner-resize icon-button"
            aria-label={`调整${widget.data.title}尺寸`}
            {...editor.resize}
          >
            <ResizeGrip />
          </Button>
        ) : null}
      </article>
      {detail ? (
        <Modal title={widget.data.title} close={() => setDetail(false)}>
          <div className="widget-detail-view">
            <WidgetView {...view} expanded />
          </div>
          <p className="subtle">{props.online ? '实时数据' : 'Core 离线 · 显示上次数据'}</p>
        </Modal>
      ) : null}
    </>
  );
});
function NameForm({
  initial,
  label,
  submit,
}: {
  initial: string;
  label: string;
  submit: (value: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void submit(name.trim()).finally(() => setBusy(false));
      }}
    >
      <label>
        {label}
        <input
          autoFocus
          required
          value={name}
          maxLength={50}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <Button className="primary" pending={busy} disabled={!name.trim()} type="submit">
        <Check size={16} />
        保存
      </Button>
    </form>
  );
}
function WidgetConfig({
  widget,
  layout,
  close,
  notify,
  commitLayout,
  canEdit,
}: {
  widget: Entity<Widget>;
  layout?: Entity<Layout>;
  close: () => void;
  notify: (s: string) => void;
  commitLayout: (l: Layout) => Promise<void>;
  canEdit: boolean;
}) {
  const [title, setTitle] = useState(widget.data.title);
  const [source, setSource] = useState(widget.data.source);
  const [geometry, setGeometry] = useState(layout?.data);
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [profiles, setProfiles] = useState(widget.data.sizeProfiles || {});
  const activeProfile = geometry
    ? widgetProfile({ ...widget.data, sizeProfiles: profiles }, geometry)
    : {
        presentation: widget.data.presentation || 'auto',
        chartStyle: widget.data.chartStyle || 'line',
        blocks: {},
      };
  const presentation = activeProfile.presentation,
    chartStyle = activeProfile.chartStyle;
  const updateProfile = (patch: Partial<WidgetProfile>) => {
    if (geometry)
      setProfiles({ ...profiles, [profileKey(geometry)]: { ...activeProfile, ...patch } });
  };
  const setPresentation = (presentation: string) => updateProfile({ presentation });
  const setChartStyle = (chartStyle: 'line' | 'area') => updateProfile({ chartStyle });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await core.command(widget, 'widget.update', {
        title,
        source,
        sizeProfiles: profiles,
        ...(widget.data.type === 'metric-card'
          ? { unit: source.startsWith('network.') ? 'KB/s' : '%' }
          : {}),
      });
      if (geometry && JSON.stringify(geometry) !== JSON.stringify(layout?.data))
        await commitLayout(geometry);
      close();
    } catch (e) {
      notify(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="组件配置" close={close} wide>
      <form className="form-stack" onSubmit={(e) => void save(e)}>
        <label>
          名称
          <input
            required
            disabled={!canEdit}
            value={title}
            maxLength={50}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          数据源
          <select disabled={!canEdit} value={source} onChange={(e) => setSource(e.target.value)}>
            {pluginSources(widget.data).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          呈现方式
          <select
            aria-label="呈现方式"
            disabled={!canEdit}
            value={presentation}
            onChange={(e) => setPresentation(e.target.value)}
          >
            {pluginPresentations(widget.data).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {['metric-card', 'network-chart'].includes(widget.data.type) ? (
          <label>
            趋势效果
            <select
              disabled={!canEdit}
              value={chartStyle}
              onChange={(e) => setChartStyle(e.target.value as 'line' | 'area')}
            >
              <option value="line">线条</option>
              <option value="area">面积填充</option>
            </select>
          </label>
        ) : null}
        <PresentationChoices
          widget={widget.data}
          type={widget.data.type}
          value={presentation}
          disabled={!canEdit}
          change={setPresentation}
        />
        <div
          className="config-preview"
          aria-label="组件实时预览"
          style={{ height: (geometry?.h || 3) * 84 - 40 }}
        >
          <h3 className="config-preview-title">{title}</h3>
          <WidgetView
            widget={{ ...widget.data, title, source }}
            profile={activeProfile}
            data={state.telemetry[`${widget.data.pluginId}/${source}`]?.value}
            download={
              state.telemetry[`${widget.data.pluginId}/network.rx`]?.value as number | undefined
            }
            upload={
              state.telemetry[`${widget.data.pluginId}/network.tx`]?.value as number | undefined
            }
            history={state.history[`${widget.data.pluginId}/${source}`] || []}
            rxHistory={
              state.history[
                widget.data.type === 'proxy-status'
                  ? `${widget.data.pluginId}/${widget.data.source}/download`
                  : `${widget.data.pluginId}/network.rx`
              ] || []
            }
            txHistory={
              state.history[
                widget.data.type === 'proxy-status'
                  ? `${widget.data.pluginId}/${widget.data.source}/upload`
                  : `${widget.data.pluginId}/network.tx`
              ] || []
            }
            online={state.online}
          />
        </div>
        <p className="subtle">
          切换尺寸和样式会即时预览，各尺寸分别保存，内部元素的位置、宽度和顺序可在编辑布局中调整
        </p>
        {geometry ? (
          <fieldset disabled={!canEdit}>
            <legend>
              {geometry.breakpoint === 'desktop'
                ? '桌面'
                : geometry.breakpoint === 'tablet'
                  ? '平板'
                  : '手机'}
              布局
            </legend>
            <div className="preset-grid">
              {pluginPresets(widget.data, geometry.breakpoint).map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  className={`secondary ${geometry.w === p.w && geometry.h === p.h ? 'chosen' : ''}`}
                  aria-pressed={geometry.w === p.w && geometry.h === p.h}
                  onClick={() =>
                    setGeometry(
                      clampLayout({
                        ...geometry,
                        w: p.w,
                        h: p.h,
                        x: Math.min(geometry.x, COLUMNS[geometry.breakpoint] - p.w),
                      }),
                    )
                  }
                >
                  <span>{p.label}</span>
                  <small>
                    {p.w} × {p.h}
                  </small>
                </Button>
              ))}
            </div>
            <div className="geometry-inputs">
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <label key={k}>
                  {{ x: '列', y: '行', w: '宽', h: '高' }[k]}
                  <input
                    type="number"
                    min={k === 'w' || k === 'h' ? 2 : 0}
                    max={k === 'y' ? 10000 : k === 'h' ? 12 : COLUMNS[geometry.breakpoint]}
                    value={geometry[k]}
                    onChange={(e) => setGeometry({ ...geometry, [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <Button className="primary" pending={busy} disabled={!canEdit}>
          <Check size={16} />
          保存配置
        </Button>
      </form>
      <div className="danger-zone">
        {confirmDelete ? (
          <>
            <p>确定从所有设备删除此组件？</p>
            <Button
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void core
                  .command(widget, 'widget.delete', {})
                  .then(close)
                  .catch((e) => notify(errorText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              确认删除
            </Button>
            <Button className="secondary" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button className="danger" disabled={!canEdit} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} />
            删除组件
          </Button>
        )}
      </div>
    </Modal>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="section-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function SettingsPanel({
  theme,
  setTheme,
  owner,
  online,
  notify,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  owner: boolean;
  online: boolean;
  notify: (s: string) => void;
}) {
  const [backups, setBackups] = useState<string[]>([]);
  useEffect(() => {
    if (owner && online)
      void core
        .api<string[]>('/backups')
        .then(setBackups)
        .catch((e) => notify(errorText(e)));
  }, [online, owner]);
  const backup = async () => {
    try {
      const result = await core.api<{ name: string }>('/backups', {});
      setBackups((v) => [...v, result.name]);
      notify('一致性备份已保存到 Core 的 backups 目录');
    } catch (e) {
      notify(errorText(e));
    }
  };
  const download = async (name: string) => {
    if (native) {
      notify('原生端备份已保存在 Core 数据目录，可在电脑上取出');
      return;
    }
    try {
      const response = await fetch(
        core.state.endpoint!.uri + '/api/v1/backups/' + encodeURIComponent(name),
        { headers: { Authorization: 'Bearer ' + core.token } },
      );
      if (!response.ok) throw new Error('备份下载失败');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notify(errorText(e));
    }
  };
  return (
    <>
      <SectionHeading
        eyebrow="MAKE THIS SPACE YOURS"
        title="按你的习惯"
        description={
          theme.experience === 'uranus23'
            ? '在冰昼与永夜之间，留下你的日常'
            : '白昼与黑夜，两种底色，雾绿只是点缀，颜色由你选择'
        }
      />
      <div className="panel">
        <div className="panel-title">
          <h2>外观</h2>
          <span className="subtle">此设备的偏好</span>
        </div>
        <UranusSettings />
        <div className="theme-options">
          {(
            [
              {
                mode: 'day',
                title: theme.experience === 'uranus23' ? '冰昼' : '白昼',
                icon: <Sun size={19} />,
              },
              {
                mode: 'night',
                title: theme.experience === 'uranus23' ? '永夜' : '黑夜',
                icon: <Moon size={19} />,
              },
              { mode: 'system', title: '跟随系统', icon: <Monitor size={19} /> },
            ] as const
          ).map((t) => (
            <Button
              selected={theme.mode === t.mode}
              key={t.mode}
              className={`theme-option ${t.mode} ${theme.mode === t.mode ? 'chosen' : ''}`}
              onClick={() => setTheme({ ...theme, mode: t.mode })}
            >
              <span className="theme-preview">
                <i />
                <i />
                <i />
              </span>
              <span>
                {t.icon}
                {t.title}
                {theme.mode === t.mode ? <Check size={17} /> : null}
              </span>
            </Button>
          ))}
        </div>
        <div className="accent-row">
          <div>
            <h3>点缀色</h3>
            <p>用于主要操作、状态与图表，不改变界面的黑白底色</p>
          </div>
          <div className="swatches">
            {['#719b87', '#6a8eaf', '#9c88ba', '#b09165', '#888888'].map((c) => (
              <Button
                selected={theme.accent === c}
                key={c}
                aria-label={`点缀色 ${c}`}
                className={theme.accent === c ? 'chosen' : ''}
                style={{ background: c }}
                onClick={() => setTheme({ ...theme, accent: c })}
              >
                {theme.accent === c ? <Check size={14} /> : null}
              </Button>
            ))}
            <label className="custom-color" title="自定义颜色">
              <Plus size={15} />
              <input
                aria-label="自定义点缀色"
                type="color"
                value={theme.accent}
                onChange={(e) => setTheme({ ...theme, accent: e.target.value })}
              />
            </label>
          </div>
        </div>
        <ButtonPreview />
      </div>
      <AppUpdates />
      <DesktopServicePanel />
      <div className="panel">
        <div className="panel-title">
          <div>
            <h2>备份与恢复</h2>
            <p>每天自动创建一致性快照，保留最近 7 份定时备份</p>
          </div>
          <Button className="secondary" disabled={!owner || !online} onClick={() => void backup()}>
            <Download size={16} />
            立即备份
          </Button>
        </div>
        <p className="panel-description">
          数据库备份包含工作空间和设备公钥；Core 私钥由 Windows DPAPI 单独保护，恢复需要在本机停止
          Core 后执行，已有会话会清除
        </p>
        {backups
          .slice(-5)
          .reverse()
          .map((name) => (
            <div className="backup-row" key={name}>
              <span className="mono">{name}</span>
              <Button
                className="icon-button"
                disabled={!online}
                aria-label={`下载 ${name}`}
                onClick={() => void download(name)}
              >
                <Download size={17} />
              </Button>
            </div>
          ))}
      </div>
      <div className="panel">
        <div className="panel-title">
          <div>
            <h2>锁定电脑</h2>
            <p>需要 System Monitor 的「锁定电脑会话」权限</p>
          </div>
          <Button
            className="secondary"
            disabled={!online || !owner}
            onClick={() => {
              if (window.confirm('立即锁定 Core 所在电脑的会话？'))
                void core
                  .api('/actions/lock', { opId: crypto.randomUUID(), confirm: true })
                  .then(() => notify('已锁定电脑'))
                  .catch((e) => notify(errorText(e)));
            }}
          >
            <LockKeyhole size={16} />
            锁定会话
          </Button>
        </div>
      </div>
    </>
  );
}
