import { pluginPresets, pluginPresentations } from './plugin-views';
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from 'react';
import {
  AlignStartVertical,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowLeftRight,
  Minus,
  Plus,
} from 'lucide-react';
import type {
  Breakpoint,
  Entity,
  Layout,
  Widget,
  WidgetProfile,
} from '../../packages/protocol/src';
import {
  arrangeLayouts,
  clampLayout,
  compactLayouts,
  COLUMNS,
  GRID_GAP,
  ROW_HEIGHT,
  sameGeometry,
  type LayoutRecord,
} from '../../packages/widget-schema/src';
import { Button, Modal } from './components';
import { ProfileControls } from './ProfileControls';
import { GeometryControls } from './GeometryControls';
import { FloatingInspector } from './FloatingInspector';
import { connectionErrorText } from './connection-errors';
import type { ContentEditor } from './ContentLayout';
import {
  profileKey,
  widgetProfile,
  BLOCKS,
  presetsFor,
} from '../../packages/widget-schema/src/presentation';

export type EditorActions = {
  profile?: WidgetProfile;
  contentEditor?: ContentEditor;
  selected: boolean;
  dragging: boolean;
  target: boolean;
  select: () => void;
  move: ButtonHTMLAttributes<HTMLButtonElement>;
  resize: ButtonHTMLAttributes<HTMLButtonElement>;
  surface?: HTMLAttributes<HTMLElement>;
};
type Drag = {
  pointerId: number;
  button: HTMLElement;
  x: number;
  y: number;
  scrollY: number;
  scrollX: number;
  clientX: number;
  clientY: number;
  width: number;
  moved: boolean;
  mode: 'move' | 'resize';
  original: Layout;
  baseline: LayoutRecord[];
};
export function LayoutCanvas({
  widgets,
  records,
  breakpoint,
  previewMode,
  editing,
  saving,
  commit,
  saveProfile,
  configure,
  toolbar,
  historyActions,
  renderCard,
  empty,
}: {
  widgets: Entity<Widget>[];
  records: LayoutRecord[];
  breakpoint: Breakpoint;
  previewMode: string;
  editing: boolean;
  saving: boolean;
  commit: (layouts: Layout[], baseline: LayoutRecord[]) => Promise<void>;
  saveProfile: (widget: Entity<Widget>, key: string, profile: WidgetProfile) => Promise<void>;
  configure: (widget: Entity<Widget>) => void;
  toolbar: ReactNode;
  historyActions: ReactNode;
  renderCard: (widget: Entity<Widget>, layout: Layout, editor: EditorActions) => ReactNode;
  empty: ReactNode;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const planned = useRef<Layout[] | null>(null);
  const targetRef = useRef('');
  const draggedClick = useRef('');
  const [draft, setDraft] = useState<Layout[] | null>(null);
  const [active, setActive] = useState('');
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState('');
  const [swap, setSwap] = useState(false);
  const [hint, setHint] = useState('');
  const [profileDraft, setProfileDraft] = useState<WidgetProfile | null>(null);
  const profileBase = useRef<Entity<Widget> | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [contentEditing, setContentEditing] = useState(false);
  const [selectedPart, setSelectedPart] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [geometryPending, setGeometryPending] = useState(false);
  const [geometryReset, setGeometryReset] = useState(0);
  const geometryBase = useRef<LayoutRecord[] | null>(null);
  const selectedRecord = records.find((r) => r.layout.widgetId === selected);
  const selectedWidget = widgets.find((w) => w.id === selected);
  const layouts = draft || records.map((r) => r.layout);
  const selectedLayout = layouts.find((l) => l.widgetId === selected);
  const profile =
    selectedWidget && selectedLayout
      ? profileDraft || widgetProfile(selectedWidget.data, selectedLayout)
      : null;
  const profileDirty =
    !!profileDraft &&
    !!selectedWidget &&
    !!selectedLayout &&
    JSON.stringify(profileDraft) !==
      JSON.stringify(widgetProfile(selectedWidget.data, selectedLayout));
  const selectCard = (id: string, reveal = true) => {
    if (id === selected) {
      if (reveal) setCollapsed(false);
      return;
    }
    if (profileDirty || profileBusy || geometryPending) {
      setHint('先保存或取消当前预览，再选择其他卡片');
      return;
    }
    setSelected(id);
    if (reveal) setCollapsed(false);
    setProfileDraft(null);
    profileBase.current = null;
    setProfileError('');
    setContentEditing(false);
    setSelectedPart('');
  };
  const clickCard = (id: string, keyboard = false) => {
    const suppress = draggedClick.current === id && !keyboard;
    draggedClick.current = '';
    if (!suppress) selectCard(id);
  };
  const changeProfile = (next: WidgetProfile) => {
    profileBase.current ??= selectedWidget!;
    setProfileDraft(next);
    setProfileError('');
  };
  const persistProfile = async () => {
    if (!selectedWidget || !selectedLayout || !profile) return;
    setProfileBusy(true);
    try {
      await saveProfile(profileBase.current || selectedWidget, profileKey(selectedLayout), profile);
      setProfileDraft(null);
      profileBase.current = null;
      setProfileError('');
      setHint('当前尺寸预设已保存');
    } catch (error) {
      setProfileError(connectionErrorText(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const cancel = () => {
    const current = drag.current;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    if (current?.button.hasPointerCapture(current.pointerId))
      current.button.releasePointerCapture(current.pointerId);
    planned.current = null;
    setDraft(null);
    setActive('');
    setTarget('');
    targetRef.current = '';
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        cancel();
        setHint('已取消拖动');
      }
    };
    const resize = () => {
      if (drag.current) cancel();
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame.current);
      const current = drag.current;
      drag.current = null;
      if (current?.button.hasPointerCapture(current.pointerId))
        current.button.releasePointerCapture(current.pointerId);
    };
  }, []);
  useEffect(() => {
    if (!editing || (saving && drag.current)) cancel();
  }, [editing, saving]);
  const save = async (next: Layout[], baseline = records) => {
    if (saving || !editing) return;
    try {
      await commit(next, baseline);
      setHint('布局已保存');
    } catch {
      setHint('未保存，请检查最新布局后重试');
    }
  };
  const cancelGeometry = () => {
    geometryBase.current = null;
    setGeometryPending(false);
    setGeometryReset((value) => value + 1);
    setDraft(null);
  };
  useEffect(() => {
    if (!editing) cancelGeometry();
  }, [editing]);
  const tick = () => {
    const d = drag.current;
    if (!d) return;
    d.moved ||= Math.hypot(d.clientX - d.x, d.clientY - d.y) > 6;
    if (!d.moved) {
      frame.current = requestAnimationFrame(tick);
      return;
    }
    const edge = 64;
    const bottom = innerHeight;
    const dy =
      d.clientY < edge
        ? -Math.ceil((edge - d.clientY) / 4)
        : d.clientY > bottom - edge
          ? Math.ceil((d.clientY - bottom + edge) / 4)
          : 0;
    if (dy && Math.abs(d.clientY - d.y) > 12) window.scrollBy(0, Math.max(-20, Math.min(20, dy)));
    const viewport = scroller.current!;
    const bounds = viewport.getBoundingClientRect();
    if (viewport.scrollWidth > viewport.clientWidth) {
      if (d.clientX < bounds.left + 40) viewport.scrollLeft -= 12;
      else if (d.clientX > bounds.right - 40) viewport.scrollLeft += 12;
    }
    const step = (d.width + GRID_GAP) / COLUMNS[breakpoint];
    const dx = Math.round((d.clientX - d.x + viewport.scrollLeft - d.scrollX) / step);
    const rows = Math.round((d.clientY - d.y + window.scrollY - d.scrollY) / ROW_HEIGHT);
    const desired = clampLayout(
      d.mode === 'move'
        ? { ...d.original, x: d.original.x + dx, y: d.original.y + rows }
        : {
            ...d.original,
            w: Math.min(COLUMNS[breakpoint] - d.original.x, d.original.w + dx),
            h: d.original.h + rows,
          },
    );
    const baseline = d.baseline.map((r) => r.layout);
    const centerX = desired.x + desired.w / 2;
    const centerY = desired.y + desired.h / 2;
    const swapTarget =
      d.mode === 'move' && !sameGeometry(desired, d.original)
        ? baseline.find(
            (l) =>
              l.widgetId !== desired.widgetId &&
              centerX >= l.x &&
              centerX < l.x + l.w &&
              centerY >= l.y &&
              centerY < l.y + l.h,
          )?.widgetId || ''
        : '';
    const next = arrangeLayouts(baseline, desired, swapTarget);
    if (JSON.stringify(next) !== JSON.stringify(planned.current)) {
      planned.current = next;
      setDraft(next);
    }
    if (swapTarget !== targetRef.current) {
      targetRef.current = swapTarget;
      setTarget(swapTarget);
    }
    frame.current = requestAnimationFrame(tick);
  };
  const begin = (event: PointerEvent<HTMLElement>, layout: Layout, mode: Drag['mode']) => {
    if (
      !editing ||
      saving ||
      profileBusy ||
      geometryPending ||
      drag.current ||
      (mode === 'resize' && (profileDirty || contentEditing)) ||
      (profileDirty && layout.widgetId !== selected) ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      !event.isPrimary
    )
      return;
    event.preventDefault();
    draggedClick.current = '';
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      button: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollY: window.scrollY,
      scrollX: scroller.current!.scrollLeft,
      width: canvas.current!.clientWidth,
      moved: false,
      original: layout,
      baseline: records,
      mode,
    };
    selectCard(layout.widgetId, false);
    setActive(layout.widgetId);
    setHint('');
    planned.current = null;
    frame.current = requestAnimationFrame(tick);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d?.pointerId === event.pointerId) {
      d.clientX = event.clientX;
      d.clientY = event.clientY;
    }
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    d.clientX = event.clientX;
    d.clientY = event.clientY;
    cancelAnimationFrame(frame.current);
    tick();
    cancelAnimationFrame(frame.current);
    const next = planned.current;
    cancel();
    if (d.moved) draggedClick.current = d.original.widgetId;
    if (next) void save(next, d.baseline);
  };
  const nudge = (x: number, y: number, dw = 0, dh = 0) => {
    if (
      !selectedRecord ||
      profileBusy ||
      geometryPending ||
      ((dw || dh) && (profileDirty || contentEditing))
    )
      return;
    const l = selectedRecord.layout;
    const desired = clampLayout({
      ...l,
      x: l.x + x,
      y: l.y + y,
      w: Math.min(COLUMNS[breakpoint] - l.x, l.w + dw),
      h: l.h + dh,
    });
    void save(
      arrangeLayouts(
        records.map((r) => r.layout),
        desired,
      ),
    );
  };
  const bindings = (
    layout: Layout,
    mode: Drag['mode'],
  ): ButtonHTMLAttributes<HTMLButtonElement> => ({
    onPointerDown: (event) => begin(event, layout, mode),
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: () => {
      cancel();
      setHint('拖动已取消');
    },
    onLostPointerCapture: () => {
      if (drag.current) cancel();
    },
    onClick: (event) => clickCard(layout.widgetId, event.detail === 0),
    disabled:
      saving ||
      profileBusy ||
      geometryPending ||
      (mode === 'resize' && (profileDirty || contentEditing)),
    onKeyDown: (event) => {
      if (profileBusy || geometryPending || (mode === 'resize' && (profileDirty || contentEditing)))
        return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      const desired = clampLayout(
        mode === 'move'
          ? { ...layout, x: layout.x + dx, y: layout.y + dy }
          : {
              ...layout,
              w: Math.min(COLUMNS[breakpoint] - layout.x, layout.w + dx),
              h: layout.h + dy,
            },
      );
      void save(
        arrangeLayouts(
          records.map((r) => r.layout),
          desired,
        ),
      );
    },
  });
  return (
    <>
      <div
        className={`layout-workbench ${editing ? 'workbench-editing' : ''} ${collapsed ? 'inspector-collapsed' : ''}`}
      >
        {editing ? (
          <FloatingInspector
            title={selectedWidget?.data.title || '选择一张卡片'}
            caption={
              selectedLayout ? `${selectedLayout.w} 列 × ${selectedLayout.h} 行` : '拖动卡片移位'
            }
            collapsed={collapsed}
            toggle={() => setCollapsed(!collapsed)}
            actions={historyActions}
          >
            <div className="inspector-page-tools">{toolbar}</div>
            <fieldset
              className="layout-tools-fieldset"
              disabled={geometryPending}
              hidden={!selectedRecord}
            >
              <div className="layout-tools">
                <select
                  className="layout-size-select"
                  aria-label="预制尺寸"
                  disabled={!selectedRecord || saving || profileDirty || profileBusy}
                  value={
                    selectedRecord
                      ? pluginPresets(selectedWidget?.data, breakpoint).find(
                          (p) => p.w === selectedRecord.layout.w && p.h === selectedRecord.layout.h,
                        )?.id || ''
                      : ''
                  }
                  onChange={(event) => {
                    const preset = pluginPresets(selectedWidget?.data, breakpoint).find(
                      (p) => p.id === event.target.value,
                    );
                    if (preset && selectedRecord)
                      void save(
                        arrangeLayouts(
                          records.map((r) => r.layout),
                          clampLayout({
                            ...selectedRecord.layout,
                            w: preset.w,
                            h: preset.h,
                            x: Math.min(selectedRecord.layout.x, COLUMNS[breakpoint] - preset.w),
                          }),
                        ),
                      );
                  }}
                >
                  <option value="">自定义尺寸</option>
                  {pluginPresets(selectedWidget?.data, breakpoint).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.w} × {p.h}
                    </option>
                  ))}
                </select>
                <div className="layout-tool-group" aria-label="逐格移动">
                  {[
                    { icon: ArrowLeft, x: -1, y: 0, label: '向左移动' },
                    { icon: ArrowUp, x: 0, y: -1, label: '向上移动' },
                    { icon: ArrowDown, x: 0, y: 1, label: '向下移动' },
                    { icon: ArrowRight, x: 1, y: 0, label: '向右移动' },
                  ].map((item) => (
                    <Button
                      key={item.label}
                      className="icon-button"
                      aria-label={item.label}
                      disabled={!selectedRecord || saving || profileBusy}
                      onClick={() => nudge(item.x, item.y)}
                    >
                      <item.icon size={18} />
                    </Button>
                  ))}
                </div>
                <div className="layout-tool-group">
                  <Button
                    className="secondary"
                    aria-label="减小卡片宽度"
                    disabled={!selectedRecord || saving || profileDirty || profileBusy}
                    onClick={() => nudge(0, 0, -1)}
                  >
                    <Minus size={16} />
                    宽度
                  </Button>
                  <Button
                    className="secondary"
                    aria-label="增加卡片宽度"
                    disabled={!selectedRecord || saving || profileDirty || profileBusy}
                    onClick={() => nudge(0, 0, 1)}
                  >
                    <Plus size={16} />
                    宽度
                  </Button>
                  <Button
                    className="secondary"
                    aria-label="减小卡片高度"
                    disabled={!selectedRecord || saving || profileDirty || profileBusy}
                    onClick={() => nudge(0, 0, 0, -1)}
                  >
                    <Minus size={16} />
                    高度
                  </Button>
                  <Button
                    className="secondary"
                    aria-label="增加卡片高度"
                    disabled={!selectedRecord || saving || profileDirty || profileBusy}
                    onClick={() => nudge(0, 0, 0, 1)}
                  >
                    <Plus size={16} />
                    高度
                  </Button>
                </div>
                <div className="layout-tool-group">
                  <Button
                    className="secondary"
                    disabled={!selectedRecord || widgets.length < 2 || saving || profileBusy}
                    onClick={() => setSwap(true)}
                  >
                    <ArrowLeftRight size={16} />
                    交换卡片
                  </Button>
                  <Button
                    className="secondary"
                    disabled={!widgets.length || saving || profileBusy}
                    onClick={() => void save(compactLayouts(records.map((r) => r.layout)))}
                  >
                    <AlignStartVertical size={16} />
                    自动对齐
                  </Button>
                </div>
              </div>
            </fieldset>
            {selectedRecord ? (
              <GeometryControls
                layout={selectedRecord.layout}
                reset={geometryReset}
                disabled={saving || profileBusy || profileDirty || contentEditing}
                pending={geometryPending}
                preview={(next) => {
                  geometryBase.current ??= records;
                  setGeometryPending(true);
                  setDraft(
                    arrangeLayouts(
                      geometryBase.current.map((record) => record.layout),
                      next,
                    ),
                  );
                  setHint('位置与大小实时预览，应用后同步到其他设备');
                }}
                save={() => {
                  if (!draft || !geometryBase.current) return;
                  void commit(draft, geometryBase.current)
                    .then(() => {
                      cancelGeometry();
                      setHint('位置与大小已保存');
                    })
                    .catch(() => setHint('未保存，布局可能已变更，请取消预览后重试'));
                }}
                cancel={cancelGeometry}
              />
            ) : null}
            <p className="layout-feedback" role="status">
              {active
                ? target
                  ? '松手交换卡片，其他卡片自动让位'
                  : '松手保存位置 · 滑到屏幕边缘可继续滚动 · Esc 取消'
                : saving
                  ? '正在保存整组布局…'
                  : hint ||
                    '滑动卡片内容滚动页面，拖动圆点手柄移动，右下角调整大小，点选卡片编辑样式'}
            </p>
            {!geometryPending && selectedWidget && selectedLayout && profile ? (
              <ProfileControls
                widget={selectedWidget.data}
                layout={selectedLayout}
                profile={profile}
                change={changeProfile}
                contentEditing={contentEditing}
                toggleContent={() => {
                  setContentEditing(!contentEditing);
                  setSelectedPart(BLOCKS[selectedWidget.data.type][0].id);
                }}
                selectedPart={selectedPart}
                selectPart={setSelectedPart}
                dirty={profileDirty}
                busy={profileBusy}
                save={() => void persistProfile()}
                cancel={() => {
                  setProfileDraft(null);
                  profileBase.current = null;
                  setProfileError('');
                }}
                error={profileError}
              />
            ) : null}
            {selectedWidget ? (
              <Button
                className="secondary inspector-configure"
                disabled={profileDirty || geometryPending || profileBusy}
                onClick={() => configure(selectedWidget)}
              >
                组件配置
              </Button>
            ) : null}
          </FloatingInspector>
        ) : null}
        <div ref={scroller} className={`canvas-scroll preview-${previewMode}`}>
          <div
            ref={canvas}
            className={`widget-canvas ${editing ? 'is-editing' : ''}`}
            style={
              {
                '--columns': COLUMNS[breakpoint],
                '--grid-step': `calc((100% + ${GRID_GAP}px) / ${COLUMNS[breakpoint]})`,
                height: Math.max(3, ...layouts.map((l) => l.y + l.h)) * ROW_HEIGHT - GRID_GAP,
              } as CSSProperties
            }
          >
            {widgets.map((widget) => {
              const layout = layouts.find((l) => l.widgetId === widget.id)!;
              return renderCard(widget, layout, {
                selected: selected === widget.id,
                dragging: active === widget.id,
                target: target === widget.id,
                select: () => selectCard(widget.id),
                profile: selected === widget.id ? profile || undefined : undefined,
                contentEditor:
                  editing && selected === widget.id && contentEditing && !profileBusy && profile
                    ? {
                        selected: selectedPart,
                        select: setSelectedPart,
                        change: (blocks) => changeProfile({ ...profile, blocks }),
                      }
                    : undefined,
                move: bindings(layout, 'move'),
                resize: bindings(layout, 'resize'),
                surface: editing
                  ? {
                      onPointerDown: (event) => {
                        if (
                          event.pointerType !== 'mouse' ||
                          (event.target as HTMLElement).closest('button,a,input,select,textarea') ||
                          contentEditing
                        )
                          return;
                        begin(event, layout, 'move');
                      },
                      onPointerMove: move,
                      onPointerUp: finish,
                      onPointerCancel: () => {
                        if (drag.current) {
                          cancel();
                          setHint('拖动已取消');
                        }
                      },
                      onLostPointerCapture: () => {
                        if (drag.current) cancel();
                      },
                      onClick: (event) => {
                        if (
                          !(event.target as HTMLElement).closest(
                            'button,a,input,select,textarea',
                          ) &&
                          !contentEditing
                        )
                          clickCard(widget.id, event.detail === 0);
                      },
                    }
                  : undefined,
              });
            })}
            {!widgets.length ? empty : null}
          </div>
        </div>
      </div>
      {swap && selectedRecord ? (
        <Modal title="交换卡片" close={() => setSwap(false)}>
          <p className="modal-description">
            选择要与「{selectedWidget?.data.title}」交换位置的卡片，尺寸保留，周围卡片会自动让位
          </p>
          <div className="layout-swap-list">
            {widgets
              .filter((w) => w.id !== selected)
              .map((widget) => (
                <Button
                  key={widget.id}
                  className="secondary"
                  disabled={saving}
                  onClick={() => {
                    setSwap(false);
                    void save(
                      arrangeLayouts(
                        records.map((r) => r.layout),
                        selectedRecord.layout,
                        widget.id,
                      ),
                    );
                  }}
                >
                  {widget.data.title}
                  <ArrowLeftRight size={16} />
                </Button>
              ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
