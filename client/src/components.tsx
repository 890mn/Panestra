import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { X } from 'lucide-react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  selected?: boolean;
  pending?: boolean;
};

/** Shared geometry; pressed is transient, selected is persistent, pending blocks duplicates. */
export function Button({
  children,
  className = '',
  selected,
  pending = false,
  disabled,
  type,
  ...props
}: ButtonProps) {
  const signature = /(?:^|\s)(primary|secondary|danger|status-button)(?:\s|$)/.test(className);
  const active =
    selected ?? (/(?:^|\s)(selected|chosen)(?:\s|$)/.test(className) ? true : undefined);
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || pending}
      aria-pressed={active}
      aria-busy={pending || undefined}
      className={`${className} control ${signature ? 'signature-button' : ''}`}
      data-selected={active || undefined}
    >
      {children}
      {signature ? <span className="button-status" aria-hidden="true" /> : null}
    </button>
  );
}

export function Modal({
  title,
  children,
  close,
  wide = false,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(returnFocus || (document.activeElement as HTMLElement));
  useEffect(() => {
    const previous = previousFocus.current;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <Button className="icon-button" aria-label="关闭" onClick={close}>
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function ButtonPreview() {
  const [selected, setSelected] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('选中用点缀色强调；普通操作按下后恢复');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="button-lab">
      <h3>按键状态</h3>
      <p role="status">{result}</p>
      <div className="button-row">
        <Button
          className="status-button"
          selected={selected}
          onClick={() => setSelected((value) => !value)}
        >
          保持选中
        </Button>
        <Button
          className="secondary"
          pending={pending}
          onClick={() => {
            setPending(true);
            setResult('正在演示等待反馈…');
            timer.current = setTimeout(() => {
              setPending(false);
              setResult('操作完成，一次性操作的按键回到未按下状态');
            }, 1000);
          }}
        >
          测试反馈
        </Button>
        <Button className="secondary" disabled>
          不可操作
        </Button>
      </div>
    </div>
  );
}
