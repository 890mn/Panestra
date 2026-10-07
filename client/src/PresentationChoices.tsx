import { pluginPresentations } from './plugin-views';
import type { Widget } from '../../packages/protocol/src';
import { PRESENTATIONS } from '../../packages/widget-schema/src/presentation';
import { Button } from './components';

function PreviewMark({ mode }: { mode: string }) {
  const paths: Record<string, string> = {
    auto: 'M4 5h9v7H4z M19 5h9v7h-9z M4 18h24v5H4z',
    dial: 'M4 21a12 12 0 0 1 24 0 M16 21l7-9',
    rings: 'M16 4a10 10 0 1 1-10 10 M16 9a5 5 0 1 1-5 5',
    segments: 'M4 9v10 M10 9v10 M16 9v10 M22 9v10 M28 9v10',
    bars: 'M5 22V15 M11 22V8 M17 22V12 M23 22V5 M29 22V10',
    meters: 'M4 8h24 M4 15h17 M4 22h24',
    gauge: 'M4 13h24v4H4z M4 13h15',
    tiles: 'M4 5h10v18H4z M19 5h10v18H19z',
    board: 'M4 5h24v6H4z M4 16h10v8H4z M19 16h9v8h-9z',
    route: 'M4 6h9v6H4z M19 17h9v6h-9z M8 12v8h11',
    vinyl: 'M16 4a11 11 0 1 1 0 22a11 11 0 1 1 0-22 M16 11a4 4 0 1 1 0 8a4 4 0 1 1 0-8',
    focus: 'M4 4h15v18H4z M23 10l6 4-6 4z M4 27h25',
    split: 'M3 21l4-6 4 3 4-10 M19 21l3-4 4 1 3-7',
    timeline: 'M6 5v21 M11 7h17 M11 15h13 M11 23h17',
    trend: 'M3 21l5-7 5 3 5-10 5 5 6-4',
  };
  const path =
    paths[mode] ||
    (['cover', 'player', 'track'].includes(mode) ? paths.focus : 'M4 6h24 M4 14h18 M4 22h24');
  return (
    <svg
      width="32"
      height="28"
      viewBox="0 0 32 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export function PresentationChoices({
  type,
  widget,
  value,
  disabled,
  change,
}: {
  type: Widget['type'];
  widget?: Widget;
  value: string;
  disabled?: boolean;
  change: (value: string) => void;
}) {
  return (
    <details className="presentation-library">
      <summary>
        预设样式{' '}
        <span>{(widget ? pluginPresentations(widget) : PRESENTATIONS[type]).length} 种</span>
      </summary>
      <div className="presentation-options" role="group" aria-label="预设样式">
        {(widget ? pluginPresentations(widget) : PRESENTATIONS[type]).map((choice) => (
          <Button
            key={choice.id}
            type="button"
            className="secondary presentation-choice"
            selected={value === choice.id}
            disabled={disabled}
            onClick={() => change(choice.id)}
          >
            <PreviewMark mode={choice.id} />
            <span>{choice.label}</span>
          </Button>
        ))}
      </div>
      <p>点击即时预览，空间不足时保留核心信息，详情中可查看完整内容</p>
    </details>
  );
}
