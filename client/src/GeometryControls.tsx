import { useEffect, useState } from 'react';
import type { Layout } from '../../packages/protocol/src';
import { COLUMNS } from '../../packages/widget-schema/src';
import { Button } from './components';

export function GeometryControls({
  layout,
  reset,
  disabled,
  pending,
  preview,
  save,
  cancel,
}: {
  layout: Layout;
  reset: number;
  disabled: boolean;
  pending: boolean;
  preview: (next: Layout) => void;
  save: () => void;
  cancel: () => void;
}) {
  const values = () => ({
    x: String(layout.x),
    y: String(layout.y),
    w: String(layout.w),
    h: String(layout.h),
  });
  const [draft, setDraft] = useState(values);
  useEffect(() => {
    if (!pending) setDraft(values());
  }, [layout.x, layout.y, layout.w, layout.h, reset, pending]);
  const valid = (fields: typeof draft) => {
    const { x, y, w, h } = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value === '' ? NaN : Number(value)]),
    );
    return (
      [x, y, w, h].every(Number.isInteger) &&
      x >= 0 &&
      y >= 0 &&
      y <= 10000 &&
      w >= 2 &&
      h >= 2 &&
      h <= 12 &&
      w <= COLUMNS[layout.breakpoint] &&
      x + w <= COLUMNS[layout.breakpoint]
    );
  };
  const correct = valid(draft);
  return (
    <form
      className="geometry-controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (correct && pending) save();
      }}
    >
      <div className="geometry-fields">
        {[
          {
            id: 'x' as const,
            label: '左侧列',
            min: 0,
            max: COLUMNS[layout.breakpoint] - Number(draft.w),
          },
          { id: 'y' as const, label: '顶部行', min: 0, max: 10000 },
          { id: 'w' as const, label: '宽度', min: 2, max: COLUMNS[layout.breakpoint] },
          { id: 'h' as const, label: '高度', min: 2, max: 12 },
        ].map((field) => (
          <label key={field.id}>
            {field.label}
            <input
              aria-label={`卡片${field.label}`}
              type="number"
              inputMode="numeric"
              min={field.min}
              max={Math.max(field.min, field.max || 0)}
              step={1}
              value={draft[field.id]}
              disabled={disabled}
              onChange={(event) => {
                const next = { ...draft, [field.id]: event.target.value };
                setDraft(next);
                if (valid(next))
                  preview({
                    ...layout,
                    x: Number(next.x),
                    y: Number(next.y),
                    w: Number(next.w),
                    h: Number(next.h),
                  });
              }}
            />
          </label>
        ))}
      </div>
      {!correct ? (
        <p className="form-error" role="alert">
          填写网格内的整数位置，宽度至少 2 列，高度为 2–12 行
        </p>
      ) : null}
      {pending ? (
        <div className="button-row">
          <Button type="submit" className="primary" disabled={disabled || !correct}>
            应用位置与大小
          </Button>
          <Button type="button" className="secondary" disabled={disabled} onClick={cancel}>
            取消位置预览
          </Button>
        </div>
      ) : null}
    </form>
  );
}
