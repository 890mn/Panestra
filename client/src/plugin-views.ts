import type { Breakpoint, Widget } from '../../packages/protocol/src';
import { COLUMNS } from '../../packages/widget-schema/src';
import {
  PRESENTATIONS,
  presetsFor,
  SIZE_PRESETS,
  sourcesFor,
} from '../../packages/widget-schema/src/presentation';
import { core } from './core';
export const widgetDefinition = (widget?: Widget) =>
  core.state.plugins
    .find((plugin) => plugin.id === widget?.pluginId)
    ?.manifest.widgets.find((item) => item.id === widget?.type);
const definition = widgetDefinition;
export const pluginPresets = (widget: Widget | undefined, breakpoint: Breakpoint) =>
  definition(widget)
    ?.sizePresets.filter((preset) => preset.w <= COLUMNS[breakpoint])
    .map((preset) => ({
      ...preset,
      label: SIZE_PRESETS.find((item) => item.id === preset.id)?.label || preset.id,
    })) || presetsFor(breakpoint);
export const pluginSources = (widget: Widget) =>
  definition(widget)?.subscriptions || sourcesFor(widget.type);
export const pluginPresentations = (widget: Widget) =>
  PRESENTATIONS[widget.type].filter(
    (item) => !definition(widget) || definition(widget)!.presentations.includes(item.id),
  );
