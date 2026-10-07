import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WidgetCard } from '../../client/src/App';
import '../../client/src/styles.css';
import '../../client/src/controls.css';
import '../../client/src/layout-editor.css';
import '../../client/src/widget-views.css';
import { BLOCKS, defaultBlock, PRESENTATIONS } from '../../packages/widget-schema/src/presentation';
import type { Breakpoint, Widget } from '../../packages/protocol/src';
import { core } from '../../client/src/core';
const previewRoot = createRoot(document.getElementById('root')!);
function renderPreview(query: string) {
  const params = new URLSearchParams(query);
  if (params.has('control'))
    core.patch({
      online: !params.has('offline'),
      endpoint: {
        uri: location.origin,
        serverId: 'preview-core',
        publicKeyHash: 'preview-fingerprint',
        priority: 0,
      },
      device: {
        id: 'preview-device',
        name: 'Preview',
        role: (params.get('role') || 'operator') as 'operator' | 'viewer',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
      },
    });
  const bp = (params.get('bp') as Breakpoint) || 'tablet';
  const w = Number(params.get('w') || 4),
    h = Number(params.get('h') || 3);
  const type = (params.get('type') as Widget['type']) || 'network-chart';
  const data =
    type === 'task-status'
      ? {
          enabled: true,
          prepared: true,
          hasConfiguration: true,
          instance: 'alas',
          state: 'ready',
          message: '已连接 ALAS 本机桥接',
          stale: false,
          refreshing: false,
          updatedAt: '2026-10-07T00:00:00Z',
          instances: [
            {
              name: 'alas',
              state: 'running',
              currentTask: 'OperationSirenDailyMissionWithLongName',
              waitingTask: '',
              tasks: Array.from({ length: 20 }, (_, i) => ({
                name: `LongSchedulerTaskName${i}`,
                nextRun: '2026-10-07T03:40:00+08:00',
              })),
            },
          ],
        }
      : type === 'media-control'
        ? {
            enabled: true,
            allowControl: params.has('control') && !params.has('readonly'),
            state: 'ready',
            message: '已连接网易云音乐媒体会话',
            title: '一首名称很长很长的歌曲，需要在详情完整呈现',
            artist: '歌手名称也可以很长',
            album: '一张很长的专辑名称',
            playback: 'Playing',
            positionSeconds: 75,
            durationSeconds: 245,
            controls: { toggle: true, previous: true, next: true, seek: true },
            stale: false,
            refreshing: false,
            updatedAt: '2026-10-07T00:00:00Z',
          }
        : type === 'proxy-status'
          ? {
              enabled: true,
              allowControl: false,
              autoDetect: true,
              controller: 'http://127.0.0.1:9097',
              hasCredential: true,
              state: 'ready',
              message: '已连接本机 Mihomo 控制器',
              updatedAt: '2026-10-07T00:00:00Z',
              stale: false,
              refreshing: false,
              mode: 'rule',
              version: '1.19.2',
              upload: 250000,
              download: 1536821,
              groups: [
                {
                  name: 'GLOBAL',
                  current: '东京 · 低延迟节点名称可能很长，需要在详情完整显示',
                  options: ['东京 · 低延迟节点名称可能很长，需要在详情完整显示'],
                  selectable: true,
                },
              ],
            }
          : type === 'account-usage'
            ? {
                id: params.get('account') || 'glm',
                enabled: true,
                hasCredential: true,
                state: 'ready',
                message: '',
                stale: false,
                refreshing: false,
                pollIntervalSeconds: 300,
                updatedAt: '2026-10-06T15:00:00Z',
                available: true,
                windows: [
                  {
                    id: 'TOKENS_LIMIT-1',
                    name: '编程额度 · 5 小时',
                    usedPercent: 12.5,
                    remainingPercent: 87.5,
                    current: 500,
                    limit: 4000,
                    resetsAt: 1791285300,
                  },
                  {
                    id: 'TOKENS_LIMIT-2',
                    name: '编程额度 · 1 周',
                    usedPercent: 46.5,
                    remainingPercent: 53.5,
                    current: null,
                    limit: null,
                    resetsAt: null,
                  },
                  {
                    id: 'TIME_LIMIT-0',
                    name: 'MCP 工具额度 · 1 月',
                    usedPercent: null,
                    remainingPercent: null,
                    current: null,
                    limit: null,
                    resetsAt: null,
                  },
                ],
                balances: [
                  {
                    currency: 'CNY' as const,
                    total: '110.00',
                    granted: '10.00',
                    toppedUp: '100.00',
                  },
                  { currency: 'USD' as const, total: '-1.00', granted: '0.00', toppedUp: '0.00' },
                ],
              }
            : type === 'metric-card'
              ? 99.9
              : type === 'system-overview'
                ? {
                    hostname: 'DESKTOP-WORKSTATION-123',
                    os: 'Microsoft Windows 11 Pro 10.0.26200',
                    cpu: 'Intel(R) Core(TM) Ultra 9 285K Processor @ 5.70GHz',
                    cores: 24,
                    memoryGB: 63.8,
                    uptime: 84637,
                  }
                : {
                    enabled: true,
                    state: 'ready',
                    message: '',
                    planType: 'plus',
                    stale: false,
                    refreshing: false,
                    pollIntervalSeconds: 60,
                    buckets: [
                      {
                        id: 'codex',
                        name: 'Codex',
                        windows: [
                          {
                            id: 'primary',
                            usedPercent: 12.5,
                            remainingPercent: 87.5,
                            durationMinutes: 300,
                            resetsAt: 1791285300,
                          },
                          {
                            id: 'secondary',
                            usedPercent: 46.5,
                            remainingPercent: 53.5,
                            durationMinutes: 10080,
                            resetsAt: 1791285300,
                          },
                        ],
                      },
                    ],
                    resetCredits: { availableCount: 2, expiresAt: 1791285300 },
                  };
  const modes = params.get('mode') ? [params.get('mode')!] : PRESENTATIONS[type].map((p) => p.id);
  const cols = { desktop: 12, tablet: 8, mobile: 4 }[bp];
  document.documentElement.dataset.theme = params.get('theme') || 'day';
  const canvasWidth = Number(params.get('width') || 900);
  flushSync(() =>
    previewRoot.render(
      <div style={{ width: canvasWidth, position: 'relative', height: modes.length * h * 84 }}>
        {modes.map((mode, i) => (
          <WidgetCard
            key={mode}
            widget={{
              id: mode,
              kind: 'widget',
              rev: 1,
              data: {
                pageId: 'page',
                pluginId: 'dev.panestra.system',
                type,
                source:
                  type === 'task-status'
                    ? 'task.status'
                    : type === 'media-control'
                      ? 'media.status'
                      : type === 'proxy-status'
                        ? 'proxy.status'
                        : type === 'system-overview'
                          ? 'system.info'
                          : type === 'codex-usage' || type === 'account-usage'
                            ? 'account.usage'
                            : type === 'network-chart'
                              ? 'network.rx'
                              : 'cpu.usage',
                title: '网络流量与同步状态',
                presentation: mode,
                unit: '%',
              },
            }}
            layout={{ widgetId: mode, breakpoint: bp, x: 0, y: i * h, w: Math.min(w, cols), h }}
            editor={{
              contentEditor: params.has('inner')
                ? {
                    selected: params.get('inner') || BLOCKS[type][0].id,
                    select: () => {},
                    change: () => {},
                  }
                : undefined,
              profile: params.has('custom')
                ? {
                    presentation: mode,
                    chartStyle: 'area',
                    blocks: Object.fromEntries(
                      BLOCKS[type].map((b, i) => [
                        b.id,
                        {
                          ...defaultBlock(i),
                          order: BLOCKS[type].length - 1 - i,
                          column: (i % 2) * 6,
                          span: 6,
                          align: i % 2 ? 'end' : 'center',
                        },
                      ]),
                    ),
                  }
                : undefined,
              selected: false,
              dragging: false,
              target: false,
              select: () => {},
              move: {},
              resize: {},
            }}
            editing={params.has('edit')}
            data={
              params.has('empty')
                ? undefined
                : params.has('error')
                  ? {
                      ...(data as any),
                      state: 'unavailable',
                      message: '这是一段很长的真实错误信息。'.repeat(30),
                      buckets: [],
                    }
                  : data
            }
            download={params.has('empty') ? undefined : 153682.1}
            upload={params.has('empty') ? undefined : 9876.1}
            history={params.has('empty') ? [] : [12, 43, 50, 42, 98, 40]}
            rxHistory={[12, 45, 88, 55, 90, 150]}
            txHistory={[60, 43, 40, 22, 18, 30]}
            online={!params.has('offline')}
            configure={() => {}}
          />
        ))}
      </div>,
    ),
  );
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
(window as any).renderPreview = renderPreview;
void renderPreview(location.search);
