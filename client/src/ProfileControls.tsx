import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import type { Layout, Widget, WidgetProfile } from '../../packages/protocol/src';
import { orderedBlocks, PRESENTATIONS } from '../../packages/widget-schema/src/presentation';
import { Button } from './components';
export function ProfileControls({
  widget,
  layout,
  profile,
  change,
  contentEditing,
  toggleContent,
  selectedPart,
  selectPart,
  dirty,
  busy,
  save,
  cancel,
  error,
}: {
  widget: Widget;
  layout: Layout;
  profile: WidgetProfile;
  change: (p: WidgetProfile) => void;
  contentEditing: boolean;
  toggleContent: () => void;
  selectedPart: string;
  selectPart: (id: string) => void;
  dirty: boolean;
  busy: boolean;
  save: () => void;
  cancel: () => void;
  error: string;
}) {
  const parts = orderedBlocks(widget, profile),
    part = parts.find((p) => p.id === selectedPart);
  const update = (fields: Partial<NonNullable<typeof part>['settings']>) => {
    if (part)
      change({
        ...profile,
        blocks: { ...profile.blocks, [part.id]: { ...part.settings, ...fields } },
      });
  };
  const reorder = (direction: number) => {
    if (!part) return;
    const index = parts.findIndex((p) => p.id === part.id),
      target = Math.max(0, Math.min(parts.length - 1, index + direction));
    const next = [...parts];
    next.splice(index, 1);
    next.splice(target, 0, part);
    change({
      ...profile,
      blocks: Object.fromEntries(next.map((p, i) => [p.id, { ...p.settings, order: i }])),
    });
  };
  return (
    <div className="profile-controls">
      <div className="profile-controls-heading">
        <strong>
          {layout.breakpoint === 'desktop'
            ? '桌面'
            : layout.breakpoint === 'tablet'
              ? '平板'
              : '手机'}{' '}
          · {layout.w} × {layout.h} 的呈现
        </strong>
        <span>{dirty ? '预览未保存' : '已保存的预设'}</span>
      </div>
      <div className="profile-fields">
        <label>
          呈现方式
          <select
            aria-label="当前尺寸呈现方式"
            disabled={busy}
            value={profile.presentation}
            onChange={(e) => change({ ...profile, presentation: e.target.value })}
          >
            {PRESENTATIONS[widget.type].map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {['metric-card', 'network-chart'].includes(widget.type) ? (
          <label>
            趋势效果
            <select
              aria-label="当前尺寸趋势效果"
              disabled={busy}
              value={profile.chartStyle}
              onChange={(e) =>
                change({ ...profile, chartStyle: e.target.value as 'line' | 'area' })
              }
            >
              <option value="line">线条</option>
              <option value="area">面积填充</option>
            </select>
          </label>
        ) : null}
        <Button
          className="secondary"
          selected={contentEditing}
          disabled={busy}
          onClick={toggleContent}
        >
          {contentEditing ? '结束内容编辑' : '编辑卡片内部'}
        </Button>
      </div>
      {contentEditing ? (
        <>
          <div className="profile-part-tabs">
            {parts.map((p) => (
              <Button
                key={p.id}
                className="secondary"
                selected={p.id === selectedPart}
                disabled={busy}
                onClick={() => selectPart(p.id)}
              >
                {p.label}
                {!p.settings.visible ? ' · 隐藏' : ''}
              </Button>
            ))}
          </div>
          {part ? (
            <div className="profile-fields">
              <label>
                左侧列
                <input
                  aria-label="内容左侧列"
                  type="number"
                  min={0}
                  max={12 - part.settings.span}
                  value={part.settings.column}
                  disabled={busy}
                  onChange={(e) =>
                    update({
                      column: Math.max(
                        0,
                        Math.min(12 - part.settings.span, Math.round(Number(e.target.value))),
                      ),
                    })
                  }
                />
              </label>
              <label>
                占用列数
                <input
                  aria-label="内容占用列数"
                  type="number"
                  min={1}
                  max={12 - part.settings.column}
                  value={part.settings.span}
                  disabled={busy}
                  onChange={(e) =>
                    update({
                      span: Math.max(
                        1,
                        Math.min(12 - part.settings.column, Math.round(Number(e.target.value))),
                      ),
                    })
                  }
                />
              </label>
              <label>
                内容对齐
                <select
                  aria-label="内容对齐"
                  disabled={busy}
                  value={part.settings.align}
                  onChange={(e) => update({ align: e.target.value as 'start' | 'center' | 'end' })}
                >
                  <option value="start">靠左</option>
                  <option value="center">居中</option>
                  <option value="end">靠右</option>
                </select>
              </label>
              <div className="profile-reorder">
                <Button
                  className="icon-button"
                  aria-label="内容前移"
                  disabled={busy || parts[0].id === part.id}
                  onClick={() => reorder(-1)}
                >
                  <ArrowUp size={18} />
                </Button>
                <Button
                  className="icon-button"
                  aria-label="内容后移"
                  disabled={busy || parts.at(-1)?.id === part.id}
                  onClick={() => reorder(1)}
                >
                  <ArrowDown size={18} />
                </Button>
              </div>
              <label className="profile-visibility">
                <input
                  type="checkbox"
                  disabled={busy || part.required}
                  checked={part.settings.visible}
                  onChange={(e) => update({ visible: e.target.checked })}
                />
                显示
              </label>
            </div>
          ) : null}
          <p className="subtle">
            直接拖动内容调整顺序和左右位置，宽块可拖动右下角调整宽度，小块使用占用列数调整，内部共
            12 列；空间不足时自动紧凑排布，部分辅助信息会随尺寸展开
          </p>
        </>
      ) : null}
      <div className="profile-save-row">
        <Button className="primary" pending={busy} disabled={!dirty} onClick={save}>
          保存当前尺寸预设
        </Button>
        <Button className="secondary" disabled={!dirty || busy} onClick={cancel}>
          取消预览
        </Button>
        <Button
          className="secondary"
          disabled={busy}
          onClick={() =>
            change({
              presentation: widget.presentation || 'auto',
              chartStyle: widget.chartStyle || 'line',
              blocks: {},
            })
          }
        >
          <RotateCcw size={16} />
          恢复默认
        </Button>
        <span className="subtle">只修改此组件在当前屏幕、当前大小下的呈现</span>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
