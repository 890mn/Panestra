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
  Code2,
  Cpu,
  Maximize2,
  Download,
  Grip,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  Menu,
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
import QRCode from 'qrcode';
import type {
  APIError,
  CodexStatus,
  AccountStatus,
  ClashStatus,
  MediaStatus,
  AlasStatus,
  Breakpoint,
  Device,
  Entity,
  Layout,
  Page,
  Plugin,
  SystemInfo,
  Widget,
  WidgetProfile,
} from '../../packages/protocol/src';
import { SOURCES, SYSTEM, CODEX } from '../../packages/protocol/src';
import {
  COLUMNS,
  clampLayout,
  deriveLayout,
  arrangeLayouts,
  sameGeometry,
  type LayoutRecord,
} from '../../packages/widget-schema/src';
import { core } from './core';
import { canScanPairing, discover, localCoreInfo, native, scanPairing } from './platform';
import { loopbackEndpoint, parsePairingCode } from './pairing';
import { connectionErrorText } from './connection-errors';
import { Button, ButtonPreview, Modal } from './components';
import { SoftwareAdapters } from './SoftwareAdapters';
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
type Theme = { mode: 'day' | 'night' | 'system'; accent: string };
let initialized = false;
export function App() {
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return JSON.parse(
        localStorage.getItem('panestra.theme.v1') || '{"mode":"day","accent":"#719b87"}',
      );
    } catch {
      return { mode: 'day', accent: '#719b87' };
    }
  });
  const [activePage, setActivePage] = useState('page-overview');
  const [section, setSection] = useState('workspace');
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<Breakpoint | 'auto'>('auto');
  const [width, setWidth] = useState(window.innerWidth);
  const [modal, setModal] = useState('');
  const [configuration, setConfiguration] = useState<Entity<Widget> | null>(null);
  const [notice, setNotice] = useState('');
  const [sidebar, setSidebar] = useState(false);
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
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme.mode === 'system' ? (m.matches ? 'night' : 'day') : theme.mode;
      document.documentElement.style.setProperty('--accent', theme.accent);
    };
    apply();
    m.addEventListener('change', apply);
    localStorage.setItem('panestra.theme.v1', JSON.stringify(theme));
    return () => m.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') core.resume();
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
    pluginId = SYSTEM,
  ) => {
    if (!currentPage) return;
    const id = 'widget-' + crypto.randomUUID();
    await core.command({ id, rev: 0 }, 'widget.create', {
      pageId: currentPage.id,
      pluginId,
      type,
      title,
      source,
      unit: source.startsWith('network') ? 'KB/s' : '%',
      color: 'sage',
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
  if (!state.snapshot && !state.device)
    return (
      <>
        <ConnectScreen
          theme={theme}
          toggleTheme={() => setTheme({ ...theme, mode: theme.mode === 'night' ? 'day' : 'night' })}
        />
        {notice ? (
          <div role="status" className="toast">
            {notice}
          </div>
        ) : null}
      </>
    );
  const system = state.telemetry[`${SYSTEM}/system.info`]?.value as SystemInfo | undefined;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
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
                setSidebar(false);
              }}
            >
              <LayoutDashboard size={18} />
              <span>{page.data.title}</span>
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
                setSidebar(false);
              }}
            >
              {item.icon}
              <span>{item.title}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="core-status">
            <span className={`status-light ${state.online ? '' : 'offline'}`} />
            <div>
              <strong>{system?.hostname || 'Panestra Core'}</strong>
              <small>{state.online ? '已连接 · HTTPS / WSS' : '离线 · 缓存只读'}</small>
            </div>
            <ShieldCheck size={17} />
          </div>
        </div>
      </aside>
      {sidebar ? (
        <Button
          className="sidebar-backdrop"
          aria-label="关闭菜单"
          onClick={() => setSidebar(false)}
        />
      ) : null}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <Button
              className="icon-button mobile-menu"
              aria-label="打开菜单"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </Button>
            <span className="topbar-context-icon">
              {section === 'workspace' ? (
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
              {section === 'workspace'
                ? currentPage?.data.title
                : section === 'plugins'
                  ? '插件'
                  : section === 'devices'
                    ? '设备与连接'
                    : '设置'}
            </strong>
            <span className="topbar-mode">
              {section === 'workspace' ? (editing ? '布局编辑' : '工作区') : '管理'}
            </span>
          </div>
          <div className="topbar-right">
            <span className="live-pill">
              <span className={`status-light ${state.online ? '' : 'offline'}`} />
              {state.online ? '实时同步' : '离线'}
            </span>
            <span className="separator" />
            <Button
              className="icon-button"
              aria-label={theme.mode === 'night' ? '切换白昼' : '切换黑夜'}
              onClick={() => setTheme({ ...theme, mode: theme.mode === 'night' ? 'day' : 'night' })}
            >
              {theme.mode === 'night' ? <Sun size={19} /> : <Moon size={19} />}
            </Button>
          </div>
        </header>
        <main>
          {!state.online ? (
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
              <Button className="secondary" onClick={() => setModal('connect')}>
                {state.pairingRequired ? '重新配对' : '连接其他 Core'}
              </Button>
            </div>
          ) : null}
          {section === 'workspace' ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR PERSONAL CONTROL PLANE</div>
                  <h1>{currentPage?.data.title || '工作空间'}</h1>
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
                  {editing ? (
                    <>
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
                    </>
                  ) : (
                    <span className="subtle toolbar-caption">
                      {widgets.length} 个组件 <span>·</span>{' '}
                      {breakpoint === 'desktop'
                        ? '桌面'
                        : breakpoint === 'tablet'
                          ? '平板'
                          : '手机'}
                      视图
                    </span>
                  )}
                  <Button
                    className="primary compact"
                    disabled={!canEdit || busy}
                    onClick={() => setModal('widget')}
                  >
                    <Plus size={17} />
                    添加组件
                  </Button>
                  {editing ? (
                    <Button
                      className="icon-button"
                      aria-label="页面选项"
                      onClick={() => setModal('page-settings')}
                    >
                      <MoreHorizontal size={20} />
                    </Button>
                  ) : null}
                </div>
              </div>
              {editing ? (
                <div className="editor-note">
                  <Grip size={15} />
                  拖动卡片标题移动，拖动右下角缩放，点选卡片可实时调整样式和内部内容，网格自动吸附
                </div>
              ) : null}
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
                renderCard={(widget, layout, editor) => (
                  <WidgetCard
                    key={widget.id}
                    widget={widget}
                    layout={layout}
                    editor={editor}
                    editing={editing && canEdit}
                    data={state.telemetry[`${widget.data.pluginId}/${widget.data.source}`]?.value}
                    download={state.telemetry[`${SYSTEM}/network.rx`]?.value as number | undefined}
                    upload={state.telemetry[`${SYSTEM}/network.tx`]?.value as number | undefined}
                    rxHistory={state.history[`${SYSTEM}/network.rx`] || []}
                    txHistory={state.history[`${SYSTEM}/network.tx`] || []}
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
              owner={owner}
              online={state.online}
              notify={notify}
              onConnect={() => setModal('connect')}
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
            {[
              {
                source: 'cpu.usage',
                title: '处理器',
                detail: '使用率与最近 60 秒趋势',
                type: 'metric-card',
              },
              {
                source: 'memory.usage',
                title: '内存',
                detail: '实时物理内存使用率',
                type: 'metric-card',
              },
              {
                source: 'disk.usage',
                title: '系统磁盘',
                detail: '系统盘空间使用情况',
                type: 'metric-card',
              },
              {
                source: 'network.rx',
                title: '网络流量',
                detail: '接收、发送与流量趋势',
                type: 'network-chart',
              },
              {
                source: 'system.info',
                title: '系统概览',
                detail: '硬件、运行时间与系统信息',
                type: 'system-overview',
              },
              {
                source: 'account.usage',
                title: 'Codex 额度',
                detail: '订阅窗口、剩余额度与重置卡',
                type: 'codex-usage',
              },
              {
                source: 'account.usage',
                title: 'GLM 编程额度',
                detail: '智谱中国区编程套餐与 MCP 工具用量',
                type: 'account-usage',
                pluginId: 'dev.panestra.glm',
              },
              {
                source: 'account.usage',
                title: 'DeepSeek 余额',
                detail: '可用余额、赠送余额与充值余额',
                type: 'account-usage',
                pluginId: 'dev.panestra.deepseek',
              },
              {
                source: 'proxy.status',
                title: 'Clash 代理状态',
                detail: '代理模式、策略组节点与收发流量',
                type: 'proxy-status',
                pluginId: 'dev.panestra.clash',
              },
              {
                source: 'task.status',
                title: 'ALAS 任务状态',
                detail: '实例状态、当前任务与下次执行',
                type: 'task-status',
                pluginId: 'dev.panestra.alas',
              },
              {
                source: 'media.status',
                title: '网易云播放',
                detail: '歌曲、播放进度与远程播放控制',
                type: 'media-control',
                pluginId: 'dev.panestra.netease',
              },
            ].map((item) => (
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
                      'pluginId' in item && item.pluginId
                        ? item.pluginId
                        : item.type === 'codex-usage'
                          ? CODEX
                          : SYSTEM,
                    ),
                  )
                }
              >
                <span className="widget-icon">
                  <Icon source={item.source} size={23} />
                </span>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
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
      {modal === 'connect' ? (
        <Modal title="连接 Core" close={() => setModal('')}>
          <ConnectForm onSuccess={() => setModal('')} />
        </Modal>
      ) : null}
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

function ConnectScreen({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) {
  return (
    <div className="connect-screen">
      <header>
        <div className="brand">
          <Brand showVersion />
        </div>
        <Button className="icon-button" aria-label="切换主题" onClick={toggleTheme}>
          {theme.mode === 'night' ? <Sun size={20} /> : <Moon size={20} />}
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
        </div>
      </main>
    </div>
  );
}
function ConnectForm({ onSuccess }: { onSuccess?: () => void }) {
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [uri, setURI] = useState(
    state.endpoint?.uri ||
      (location.protocol === 'https:' ? location.origin : 'https://localhost:9443'),
  );
  const [fingerprint, setFingerprint] = useState(state.endpoint?.publicKeyHash || '');
  const [name, setName] = useState(
    native ? '星序设备' : /Android|iPhone/.test(navigator.userAgent) ? '我的手机' : '我的电脑',
  );
  const [code, setCode] = useState('');
  const [scanned, setScanned] = useState<{ serverId: string; expiresAt: string } | null>(null);
  const [bootstrap, setBootstrap] = useState(
    !state.endpoint && !/Android/.test(navigator.userAgent),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [candidates, setCandidates] = useState<
    Array<{ uri: string; name: string; serverIdHint?: string }>
  >([]);
  useEffect(() => {
    void discover()
      .then(setCandidates)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!native) return;
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
  }, []);
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
          required
          type="url"
          value={uri}
          onChange={(e) => setURI(e.target.value)}
          placeholder="https://192.168.1.10:9443"
        />
      </label>
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
        <small>使用 Core 本机显示的指纹，发现结果仅提供地址</small>
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
          <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
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
        className={`widget-card ${editing ? 'editable' : ''} ${editor.dragging ? 'dragging' : ''} ${editing && editor.selected ? 'layout-selected' : ''} ${editing && editor.target ? 'layout-target' : ''}`}
        data-widget-type={widget.data.type}
        style={{ left, top: l.y * 84, width, height: l.h * 84 - 16 }}
        data-testid={widget.id}
      >
        <div className="widget-heading">
          {editing ? (
            <Button
              className="widget-title layout-move layout-title-move"
              aria-label={`拖动${widget.data.title}`}
              {...editor.move}
            >
              <span className="widget-icon">
                <Icon source={widget.data.source} />
              </span>
              <h3 title={widget.data.title}>{widget.data.title}</h3>
              <Grip className="title-grip" size={16} />
            </Button>
          ) : (
            <div className="widget-title">
              <span className="widget-icon">
                <Icon source={widget.data.source} />
              </span>
              <button
                className="widget-detail-trigger"
                aria-label={`查看${widget.data.title}详情`}
                onClick={() => setDetail(true)}
              >
                <h3 title={widget.data.title}>{widget.data.title}</h3>
              </button>
            </div>
          )}
          <div className="widget-controls">
            <Button
              className="icon-button"
              aria-label={`配置${widget.data.title}`}
              onClick={configure}
            >
              <MoreHorizontal size={18} />
            </Button>
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
            <Maximize2 size={18} />
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
            {sourcesFor(widget.data.type).map((s) => (
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
            {PRESENTATIONS[widget.data.type].map((p) => (
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
            download={state.telemetry[`${SYSTEM}/network.rx`]?.value as number | undefined}
            upload={state.telemetry[`${SYSTEM}/network.tx`]?.value as number | undefined}
            history={state.history[`${widget.data.pluginId}/${source}`] || []}
            rxHistory={state.history[`${SYSTEM}/network.rx`] || []}
            txHistory={state.history[`${SYSTEM}/network.tx`] || []}
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
              {presetsFor(geometry.breakpoint).map((p) => (
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
function PluginsPanel({
  owner,
  online,
  notify,
}: {
  owner: boolean;
  online: boolean;
  notify: (s: string) => void;
}) {
  const [update, setUpdate] = useState<{
    available: boolean;
    message?: string;
    version?: string;
    permissions?: Array<{ id: string; required: boolean }>;
  } | null>(null);
  const [consent, setConsent] = useState<string[]>([]);
  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [metrics, setMetrics] = useState(false);
  const [lock, setLock] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!online) return;
    void core
      .api<Plugin[]>('/plugins')
      .then((list) => {
        setPlugin(list[0]);
        setMetrics(list[0].permissions['system.metrics.read']);
        setLock(list[0].permissions['system.session.lock']);
      })
      .catch((e) => notify(errorText(e)));
  }, [online]);
  const apply = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await core.api<Plugin>('/plugins/system', { enabled, metrics, lock });
      setPlugin(next);
      notify(
        enabled ? 'System Monitor 已启用，真实数据将通过 WebSocket 推送' : 'System Monitor 已停用',
      );
    } catch (e) {
      notify(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionHeading
        eyebrow="PANESTRA BACKPLANE"
        title="能力，随插即用"
        description="每个插件都在独立进程中运行，你决定它能做什么"
      />
      <div className="plugin-card panel">
        <div className="plugin-card-head">
          <div className="plugin-logo">
            <Cpu size={30} />
          </div>
          <div>
            <div className="inline-heading">
              <h2>System Monitor</h2>
              <span className="badge">内置</span>
            </div>
            <p>处理器、内存、磁盘与网络，你的电脑，此刻的状态</p>
            <span className="mono subtle">dev.panestra.system · {plugin?.version || '0.1.0'}</span>
          </div>
          <span className="status-chip">
            <span
              className={`status-light ${plugin?.status === 'running' || plugin?.status === 'starting' ? '' : 'offline'}`}
            />
            {plugin?.status === 'running'
              ? '运行中'
              : plugin?.status === 'starting'
                ? '启动中'
                : plugin
                  ? '已停止'
                  : '未读取'}
          </span>
        </div>
        <div className="plugin-features">
          <span>
            <Activity size={16} />6 个数据源
          </span>
          <span>
            <LayoutDashboard size={16} />3 类组件
          </span>
          <span>
            <LockKeyhole size={16} />1 个操作
          </span>
          <span>
            <ShieldCheck size={16} />
            独立 Worker
          </span>
        </div>
        <div className="permission-section">
          <h3>插件权限</h3>
          <label className="permission-row">
            <div>
              <strong>读取系统指标</strong>
              <span>CPU、内存、磁盘和网络状态，此插件的必需权限</span>
            </div>
            <input
              disabled={!owner || !online}
              type="checkbox"
              checked={metrics}
              onChange={(e) => setMetrics(e.target.checked)}
            />
          </label>
          <label className="permission-row">
            <div>
              <strong>锁定电脑会话</strong>
              <span>允许通过已授权设备锁定本机，默认关闭</span>
            </div>
            <input
              disabled={!owner || !online}
              type="checkbox"
              checked={lock}
              onChange={(e) => setLock(e.target.checked)}
            />
          </label>
        </div>
        <div className="panel-footer">
          <span className="subtle">
            {plugin ? `Worker 重启 ${plugin.restarts} 次` : '尚未读取插件状态'}
          </span>
          <div className="button-row">
            <Button
              className="secondary"
              disabled={!owner || !online || busy}
              onClick={() => void apply(false)}
            >
              停用
            </Button>
            <Button
              className="primary"
              pending={busy}
              disabled={!owner || !online || !metrics}
              onClick={() => void apply(true)}
            >
              <Plug size={16} />
              {busy ? '正在应用…' : '授权并启用'}
            </Button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">
          <div>
            <h2>第一方插件更新</h2>
            <p>新版本先验证签名与健康状态，失败时继续运行当前版本</p>
          </div>
          <Button
            className="secondary"
            disabled={!owner || !online || busy}
            onClick={() =>
              void core
                .api<NonNullable<typeof update>>('/plugins/system/update')
                .then(setUpdate)
                .catch((e) => notify(errorText(e)))
            }
          >
            检查待更新版本
          </Button>
        </div>
        {update ? (
          <>
            <p className="panel-description">
              {update.available
                ? `可切换到 System Monitor ${update.version}`
                : update.message || '当前没有待更新版本'}
            </p>
            {update.available ? (
              <>
                {update.permissions
                  ?.filter((p) => !Object.hasOwn(plugin?.permissions || {}, p.id))
                  .map((p) => (
                    <label className="permission-row" key={p.id}>
                      <div>
                        <strong>{p.id}</strong>
                        <span>新版本申请的{p.required ? '必需' : '可选'}权限，请核对后授权</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={consent.includes(p.id)}
                        onChange={(e) =>
                          setConsent(
                            e.target.checked
                              ? [...consent, p.id]
                              : consent.filter((c) => c !== p.id),
                          )
                        }
                      />
                    </label>
                  ))}
                <Button
                  className="primary"
                  pending={busy}
                  onClick={() => {
                    setBusy(true);
                    void core
                      .api<Plugin>('/plugins/system/update', { consent })
                      .then((next) => {
                        setPlugin(next);
                        setUpdate(null);
                        setConsent([]);
                        notify('插件版本已切换');
                      })
                      .catch((e) => notify(errorText(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? '验证新版本…' : '验证并切换'}
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      <SoftwareAdapters />
      <div className="quiet-note">
        <ShieldCheck size={18} />
        <p>当前仅启用随应用构建的第一方原生插件，公开插件市场和不可信原生扩展不在此版本范围内</p>
      </div>
    </>
  );
}
function DevicesPanel({
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
  const [devices, setDevices] = useState<Device[]>([]);
  const [windowData, setWindowData] = useState<{
    code: string;
    expiresAt: string;
    fingerprint: string;
    endpoints?: string[];
  } | null>(null);
  const [pending, setPending] = useState<Array<{ id: string; name: string; keyHash: string }>>([]);
  const [qr, setQR] = useState('');
  const [qrEndpoint, setQREndpoint] = useState('');
  const [remote, setRemote] = useState(false);
  const [revoke, setRevoke] = useState<Device | null>(null);
  const reload = () =>
    core
      .api<Device[]>('/devices')
      .then(setDevices)
      .catch((e) => notify(errorText(e)));
  useEffect(() => {
    if (owner && online) void reload();
  }, [owner, online]);
  useEffect(() => {
    if (!windowData || !online) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() > Date.parse(windowData.expiresAt)) {
        setWindowData(null);
        return;
      }
      void core
        .api<typeof pending>('/pairing/pending')
        .then((p) => {
          if (!stopped) setPending(p);
        })
        .catch((e) => notify(errorText(e)));
    }, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [windowData, online]);
  const openWindow = async () => {
    try {
      const result = await core.api<NonNullable<typeof windowData>>('/pairing/window', { remote });
      setWindowData(result);
      const ep = core.state.endpoint!;
      const address = loopbackEndpoint(ep.uri) ? result.endpoints?.[0] || ep.uri : ep.uri;
      setQREndpoint(address);
      setQR(
        await QRCode.toDataURL(
          JSON.stringify({
            schemaVersion: 1,
            endpoint: address,
            serverId: ep.serverId,
            fingerprint: result.fingerprint,
            code: result.code,
            expiresAt: result.expiresAt,
          }),
          { width: 220, margin: 2 },
        ),
      );
    } catch (e) {
      notify(errorText(e));
    }
  };
  const approve = async (id: string, accept: boolean, role: string) => {
    try {
      await core.api('/pairing/approve', { id, approve: accept, role });
      setPending((p) => p.filter((v) => v.id !== id));
      if (accept) setWindowData(null);
      await reload();
      notify(accept ? '设备已配对' : '已拒绝配对请求');
    } catch (e) {
      notify(errorText(e));
    }
  };
  return (
    <>
      <SectionHeading
        eyebrow="EVERY DEVICE, ONE WORKSPACE"
        title="你的所有屏幕"
        description="发现提供地址，设备密钥确认身份，权限决定可以执行的操作"
      />
      <div className="panel endpoint-panel">
        <div className="machine-icon">
          <Monitor size={26} />
        </div>
        <div>
          <h3>{core.state.identity?.serverId || 'Panestra Core'}</h3>
          <p className="mono">{core.state.endpoint?.uri}</p>
        </div>
        <span className="status-chip">
          <ShieldCheck size={15} />
          身份已固定
        </span>
        <Button className="secondary" onClick={onConnect}>
          连接其他 Core
        </Button>
      </div>
      <div className="panel">
        <div className="panel-title">
          <h2>已信任设备</h2>
          {owner ? (
            <Button
              className="primary compact"
              disabled={!online}
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
              />
              此次允许远程配对（仍须在 Core 本机开启）
            </label>
            <div className="device-list">
              {devices.map((d) => (
                <div className="device-row" key={d.id}>
                  <span className="device-type">
                    {/手机|Phone|Android/i.test(d.name) ? (
                      <Smartphone size={22} />
                    ) : /平板|Tablet/i.test(d.name) ? (
                      <Tablet size={22} />
                    ) : (
                      <Monitor size={22} />
                    )}
                  </span>
                  <div className="device-details">
                    <strong>
                      {d.name}
                      {d.id === core.state.device?.id ? (
                        <span className="badge">当前设备</span>
                      ) : null}
                    </strong>
                    <span>
                      {d.revokedAt
                        ? '已撤销'
                        : '最近连接 ' + new Date(d.lastSeenAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <span className="badge">{d.role}</span>
                  <Button
                    className="icon-button danger-text"
                    aria-label={`撤销${d.name}`}
                    disabled={!online || Boolean(d.revokedAt) || d.id === core.state.device?.id}
                    onClick={() => setRevoke(d)}
                  >
                    <Trash2 size={17} />
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="panel-empty">
            只有 Owner 可以管理设备，当前角色：{core.state.device?.role || '离线'}
          </p>
        )}
      </div>
      {windowData ? (
        <div className="panel pairing-panel">
          <div>{qr ? <img src={qr} alt="包含地址、Core 指纹与一次性配对码的二维码" /> : null}</div>
          <div>
            <h2>在新设备上完成配对</h2>
            <p>配对窗口持续 2 分钟，使用局域网地址连接，并核对以下指纹</p>
            <label>
              二维码连接地址
              <select
                aria-label="二维码连接地址"
                value={qrEndpoint}
                onChange={(e) => {
                  const address = e.target.value;
                  setQREndpoint(address);
                  void QRCode.toDataURL(
                    JSON.stringify({
                      schemaVersion: 1,
                      endpoint: address,
                      serverId: core.state.endpoint!.serverId,
                      fingerprint: windowData.fingerprint,
                      code: windowData.code,
                      expiresAt: windowData.expiresAt,
                    }),
                    { width: 220, margin: 2 },
                  ).then(setQR);
                }}
              >
                {Array.from(new Set([qrEndpoint, ...(windowData.endpoints || [])])).map(
                  (address) => (
                    <option key={address} value={address}>
                      {address}
                    </option>
                  ),
                )}
              </select>
            </label>
            <span className="pairing-code">{windowData.code}</span>
            <p className="mono fingerprint">{windowData.fingerprint}</p>
            <small>
              手机选择“扫描电脑配对二维码”即可填入连接信息；多网卡时请选择手机可访问的局域网地址
            </small>
          </div>
        </div>
      ) : null}
      {pending.map((p) => (
        <div className="panel pending-panel" key={p.id}>
          <h3>{p.name} 请求连接</h3>
          <p>设备公钥指纹</p>
          <p className="mono fingerprint">{p.keyHash}</p>
          <div className="button-row">
            <Button className="secondary" onClick={() => void approve(p.id, false, 'viewer')}>
              拒绝
            </Button>
            <Button className="secondary" onClick={() => void approve(p.id, true, 'viewer')}>
              允许查看
            </Button>
            <Button className="primary" onClick={() => void approve(p.id, true, 'operator')}>
              允许查看与编辑
            </Button>
          </div>
        </div>
      ))}
      <div className="quiet-note">
        <Wifi size={18} />
        <p>LAN、DNS、Tailscale 或其他隧道仅改变地址，每条连接都使用相同的 TLS 身份与授权校验</p>
      </div>
      {revoke ? (
        <Modal title="撤销设备" close={() => setRevoke(null)}>
          <p>撤销「{revoke.name}」后，它的会话会立即断开，之后无法再次认证</p>
          <Button
            className="danger"
            onClick={() => {
              void core
                .api(`/devices/${encodeURIComponent(revoke.id)}/revoke`, {})
                .then(() => {
                  setRevoke(null);
                  return reload();
                })
                .catch((e) => notify(errorText(e)));
            }}
          >
            确认撤销
          </Button>
        </Modal>
      ) : null}
    </>
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
        description="白昼与黑夜，两种底色，雾绿只是点缀，颜色由你选择"
      />
      <div className="panel">
        <div className="panel-title">
          <h2>外观</h2>
          <span className="subtle">此设备的偏好</span>
        </div>
        <div className="theme-options">
          {(
            [
              { mode: 'day', title: '白昼', icon: <Sun size={19} /> },
              { mode: 'night', title: '黑夜', icon: <Moon size={19} /> },
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
