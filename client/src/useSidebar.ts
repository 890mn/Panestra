import { useEffect, useRef, useState, type HTMLAttributes } from 'react';

const preference = 'panestra.sidebar.v1';
export function useSidebar(smallScreen: boolean) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(preference) === 'collapsed';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; claimed: boolean } | null>(null);
  const suppressClick = useRef(false);
  const visible = smallScreen ? mobileOpen : !collapsed;
  useEffect(() => {
    try {
      localStorage.setItem(preference, collapsed ? 'collapsed' : 'expanded');
    } catch {}
  }, [collapsed]);
  const close = () => {
    if (smallScreen) setMobileOpen(false);
    else setCollapsed(true);
    toggle.current?.focus({ preventScroll: true });
  };
  const open = () => {
    if (smallScreen) setMobileOpen(true);
    else setCollapsed(false);
  };
  useEffect(() => {
    if (!smallScreen || !mobileOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        setMobileOpen(false);
        toggle.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [smallScreen, mobileOpen]);
  const finish = (element: HTMLElement, pointer: number) => {
    gesture.current = null;
    if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
  };
  const bindings: HTMLAttributes<HTMLElement> = {
    onPointerDown: (event) => {
      suppressClick.current = false;
      if (
        !visible ||
        !event.isPrimary ||
        event.pointerType === 'mouse' ||
        (event.target as HTMLElement).closest('dialog,input,select,textarea')
      )
        return;
      gesture.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        claimed: false,
      };
    },
    onPointerMove: (event) => {
      const start = gesture.current;
      if (!start || start.pointer !== event.pointerId) return;
      const dx = event.clientX - start.x,
        dy = event.clientY - start.y;
      if (!start.claimed && Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      if (dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        start.claimed = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    onPointerUp: (event) => {
      const start = gesture.current;
      if (!start || start.pointer !== event.pointerId) return;
      const dx = event.clientX - start.x,
        dy = event.clientY - start.y;
      finish(event.currentTarget, event.pointerId);
      if (start.claimed && dx <= -56 && Math.abs(dx) > Math.abs(dy) * 1.5) close();
    },
    onPointerCancel: (event) => finish(event.currentTarget, event.pointerId),
    onLostPointerCapture: (event) => {
      // A child button may lose its implicit capture when the sidebar claims the swipe.
      if (
        event.target === event.currentTarget &&
        !event.currentTarget.hasPointerCapture(event.pointerId)
      )
        gesture.current = null;
    },
    onClickCapture: (event) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  return { visible, toggle, bindings, close, open, dismissMobile: () => setMobileOpen(false) };
}
