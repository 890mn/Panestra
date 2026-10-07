import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Grip, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from './components';

type Position = { x: number; y: number };
export function FloatingInspector({
  title,
  caption,
  collapsed,
  toggle,
  actions,
  children,
}: {
  title: string;
  caption: string;
  collapsed: boolean;
  toggle: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const drag = useRef<{
    pointer: number;
    element: HTMLElement;
    x: number;
    y: number;
    origin: Position;
  } | null>(null);
  const clamp = (next: Position): Position => {
    const rect = panel.current!.getBoundingClientRect();
    return {
      x: Math.max(12, Math.min(innerWidth - rect.width - 12, next.x)),
      y: Math.max(84, Math.min(Math.max(84, innerHeight - rect.height - 12), next.y)),
    };
  };
  useEffect(() => {
    const resize = () =>
      setPosition((current) => {
        if (!current) return null;
        const next = clamp(current);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    const escape = (event: KeyboardEvent) => {
      const current = drag.current;
      if (event.key !== 'Escape' || !current) return;
      event.preventDefault();
      drag.current = null;
      setPosition(clamp(current.origin));
      if (current.element.hasPointerCapture(current.pointer))
        current.element.releasePointerCapture(current.pointer);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(panel.current!);
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', escape);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', escape);
      const current = drag.current;
      drag.current = null;
      if (current?.element.hasPointerCapture(current.pointer))
        current.element.releasePointerCapture(current.pointer);
    };
  }, []);
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const rect = panel.current!.getBoundingClientRect();
    drag.current = {
      pointer: event.pointerId,
      element: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      origin: { x: rect.x, y: rect.y },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    if (cancel) setPosition(clamp(current.origin));
    if (current.element.hasPointerCapture(current.pointer))
      current.element.releasePointerCapture(current.pointer);
  };
  return (
    <aside
      ref={panel}
      className="layout-inspector"
      aria-label="布局编辑面板"
      style={
        position
          ? ({ left: position.x, top: position.y, right: 'auto', bottom: 'auto' } as CSSProperties)
          : undefined
      }
    >
      <div className="layout-inspector-title">
        <Button
          className="icon-button inspector-move"
          aria-label="移动编辑面板"
          onPointerDown={start}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current?.pointer === event.pointerId)
              setPosition(
                clamp({
                  x: current.origin.x + event.clientX - current.x,
                  y: current.origin.y + event.clientY - current.y,
                }),
              );
          }}
          onPointerUp={(event) => finish(event)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => finish(event, true)}
          onKeyDown={(event) => {
            if (event.key === 'Home') {
              event.preventDefault();
              setPosition(null);
            } else if (event.key.startsWith('Arrow')) {
              event.preventDefault();
              const rect = panel.current!.getBoundingClientRect();
              setPosition(
                clamp({
                  x:
                    rect.x +
                    (event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0),
                  y: rect.y + (event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0),
                }),
              );
            }
          }}
        >
          <Grip size={18} />
        </Button>
        <div className="inspector-caption">
          <strong>{title}</strong>
          <span>{caption}</span>
        </div>
        {actions}
        <Button
          className="icon-button inspector-toggle"
          aria-label={collapsed ? '展开编辑面板' : '收起编辑面板'}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </Button>
      </div>
      <div className="layout-inspector-body" hidden={collapsed}>
        {children}
      </div>
    </aside>
  );
}
