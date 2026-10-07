import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from 'react';
import { Maximize2 } from 'lucide-react';
import type { Widget, WidgetBlock, WidgetProfile } from '../../packages/protocol/src';
import { orderedBlocks, placeBlocks } from '../../packages/widget-schema/src/presentation';
import { Button } from './components';

export type ContentEditor = {
  selected: string;
  select: (id: string) => void;
  change: (blocks: Record<string, WidgetBlock>) => void;
};
function flatten(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flatten(child.props.children)
      : [child],
  );
}
export function ContentLayout({
  children,
  widget,
  profile,
  width,
  height,
  editor,
  playerLayout = false,
}: {
  children: ReactNode;
  widget: Widget;
  profile: WidgetProfile;
  width: number;
  height: number;
  editor?: ContentEditor;
  playerLayout?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const drag = useRef<{
    pointer: number;
    el: HTMLElement;
    x: number;
    y: number;
    mode: 'move' | 'resize';
    id: string;
    blocks: Record<string, WidgetBlock>;
    order: string[];
    rects: { id: string; x: number; y: number }[];
    width: number;
  } | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      const d = drag.current;
      if (event.key === 'Escape' && d) {
        event.preventDefault();
        drag.current = null;
        editorRef.current?.change(d.blocks);
        if (d.el.hasPointerCapture(d.pointer)) d.el.releasePointerCapture(d.pointer);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);
  const ordered = orderedBlocks(widget, profile);
  const parts = flatten(children)
    .filter(isValidElement<{ 'data-block'?: string }>)
    .filter((child) => child.props['data-block']);
  const active = ordered.filter(
    (block) =>
      parts.some((part) => part.props['data-block'] === block.id) && block.settings.visible,
  );
  const placements = placeBlocks(active, width);
  const rows = Math.max(1, ...Object.values(placements).map((p) => p.row));
  const signature =
    JSON.stringify(profile.blocks) +
    ':' +
    width +
    ':' +
    height +
    ':' +
    profile.presentation +
    ':' +
    editor?.selected;
  useLayoutEffect(() => {
    setCompact(false);
  }, [signature]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!compact && el && el.scrollHeight > el.clientHeight + 1) setCompact(true);
  });
  useLayoutEffect(
    () => () => {
      const current = drag.current;
      if (current?.el.hasPointerCapture(current.pointer))
        current.el.releasePointerCapture(current.pointer);
      drag.current = null;
    },
    [],
  );
  const start = (event: PointerEvent<HTMLElement>, id: string, mode: 'move' | 'resize') => {
    if (!editor || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0))
      return;
    event.preventDefault();
    event.stopPropagation();
    editor.select(id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      el: event.currentTarget,
      id,
      mode,
      x: event.clientX,
      y: event.clientY,
      width: ref.current!.clientWidth,
      blocks: Object.fromEntries(ordered.map((b) => [b.id, { ...b.settings }])),
      order: ordered.map((b) => b.id),
      rects: [...ref.current!.querySelectorAll<HTMLElement>('[data-part]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.part!, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!editor || !d || event.pointerId !== d.pointer) return;
    if (Math.hypot(event.clientX - d.x, event.clientY - d.y) < 6) return;
    const next = structuredClone(d.blocks),
      block = next[d.id],
      dx = Math.round(((event.clientX - d.x) / d.width) * 12);
    if (d.mode === 'resize') block.span = Math.max(1, Math.min(12 - block.column, block.span + dx));
    else {
      block.column = Math.max(0, Math.min(12 - block.span, block.column + dx));
      if (Math.abs(event.clientY - d.y) > 16) {
        const target = d.rects.reduce((a, b) =>
          Math.abs(a.y - event.clientY) < Math.abs(b.y - event.clientY) ? a : b,
        );
        const order = d.order.filter((id) => id !== d.id);
        order.splice(Math.max(0, d.order.indexOf(target.id)), 0, d.id);
        order.forEach((id, i) => (next[id].order = i));
      }
    }
    editor.change(next);
  };
  const finish = (event: PointerEvent<HTMLElement>, cancel = false) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointer) return;
    drag.current = null;
    if (cancel) editor?.change(d.blocks);
    if (d.el.hasPointerCapture(d.pointer)) d.el.releasePointerCapture(d.pointer);
  };
  const rowTemplate = Array.from({ length: rows }, (_, i) =>
    active.some((b) => b.id === 'trend' && placements[b.id].row === i + 1)
      ? 'minmax(40px,1fr)'
      : 'max-content',
  ).join(' ');
  return (
    <div
      ref={ref}
      className={`content-layout ${compact ? 'content-compact' : ''} ${editor ? 'content-editing' : ''} ${playerLayout ? 'music-player-layout' : ''}`}
      style={{ gridTemplateRows: rowTemplate }}
      data-compact={compact || undefined}
    >
      {active.map((block) => {
        const p = placements[block.id],
          resizable =
            !!editor &&
            editor.selected === block.id &&
            block.id !== 'gauge' &&
            (p.span * width) / 12 - 8 >= 260;
        return (
          <div
            key={block.id}
            data-part={block.id}
            data-align={block.settings.align}
            className={`view-block view-block-${block.id} ${editor?.selected === block.id ? 'part-selected' : ''} ${resizable ? 'part-resizable' : ''}`}
            style={
              {
                gridColumn: `${p.column + 1} / span ${p.span}`,
                gridRow: p.row,
                textAlign:
                  block.settings.align === 'start'
                    ? 'left'
                    : block.settings.align === 'end'
                      ? 'right'
                      : 'center',
              } as CSSProperties
            }
            onPointerDown={(event) => start(event, block.id, 'move')}
            onPointerMove={move}
            onPointerUp={(event) => finish(event)}
            onPointerCancel={(event) => finish(event, true)}
            onLostPointerCapture={(event) => {
              if (drag.current) finish(event, true);
            }}
          >
            {parts.find((part) => part.props['data-block'] === block.id)}
            {resizable ? (
              <Button
                className="part-resize icon-button"
                aria-label={`调整${block.label}宽度`}
                onPointerDown={(event) => start(event, block.id, 'resize')}
                onPointerMove={move}
                onPointerUp={(event) => finish(event)}
                onPointerCancel={(event) => finish(event, true)}
              >
                <Maximize2 size={16} />
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
