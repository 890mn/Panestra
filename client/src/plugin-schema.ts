import type { Widget } from '../../packages/protocol/src';
import type { InstalledPlugin } from './core';

export type SettingField = {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'boolean' | 'integer';
  status?: string;
  setup?: string;
  placeholder?: string;
  min?: number;
  max?: number;
};
export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  sources: Array<{ id: string; type: string; unit: string }>;
  widgets: Array<{
    id: Widget['type'];
    subscriptions: string[];
    defaults: Partial<Widget>;
    catalog?: Array<Partial<Widget> & { description?: string }>;
    sizePresets: Array<{ id: string; w: number; h: number }>;
    presentations: string[];
  }>;
  permissions: Array<{ id: string; required: boolean }>;
  actions: Array<{ id: string; permission: string }>;
  routes?: Array<{ method: 'GET' | 'POST'; path: string; operation: string; role: string }>;
  ui?: {
    key?: string;
    icon?: string;
    category?: string;
    subtitle?: string;
    description?: string;
    notes?: string[];
    settings?: SettingField[];
    setup?: boolean;
    permissions?: Record<string, { label: string; description: string }>;
    detailLabel?: string;
    refreshLabel?: string;
    enableLabel?: string;
    prepareLabel?: string;
    prepareEnables?: boolean;
    launcherNote?: string;
    ownerActions?: Array<{ label: string; operation: string; body: Record<string, unknown> }>;
    controls?: {
      kind: string;
      operation: string;
      enabledMessage?: string;
      readOnlyMessage?: string;
    };
  };
};
export const widgetCatalog = (plugins: InstalledPlugin[]) =>
  plugins.flatMap((plugin) =>
    plugin.manifest.widgets.flatMap((widget) =>
      (widget.catalog?.length ? widget.catalog : [widget.defaults]).map((item) => ({
        ...widget.defaults,
        ...item,
        pluginId: plugin.id,
        type: widget.id,
        title: item.title || plugin.name,
        source: item.source || widget.subscriptions[0],
        description: String(
          ('description' in item ? item.description : plugin.manifest.ui?.subtitle) || '',
        ),
      })),
    ),
  );
