import { memo, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Layers3, LayoutDashboard, Monitor, Plus, ShieldCheck } from 'lucide-react';
import type { Breakpoint, Entity, Layout, Page, Widget } from '../../packages/protocol/src';
import { coreFleet } from './core';
import { hostName, type CoreHost } from './core-fleet';
import { CoreScope } from './CoreScope';
import { Button, Modal } from './components';
import { WidgetView, type ViewProps } from './WidgetViews';
import { widgetProfile } from '../../packages/widget-schema/src/presentation';
import './core-overview.css';

export function CoreOverview({
  breakpoint,
  openHost,
  manage,
}: {
  breakpoint: Breakpoint;
  openHost: (host: CoreHost) => void;
  manage: () => void;
}) {
  const hosts = useSyncExternalStore(coreFleet.subscribe, coreFleet.getSnapshot);
  const online = hosts.filter((host) => host.state.online).length;
  return (
    <div className="core-overview">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EVERY HOST, ONE VIEW</div>
          <h1>总览</h1>
          <p>汇集已配对主机的组件，数据与操作始终归属各自主机</p>
        </div>
        <Button className="secondary" onClick={manage}>
          <Plus size={17} />
          添加或管理主机
        </Button>
      </div>
      <div className="aggregate-summary">
        <span>
          <Layers3 size={17} />
          {hosts.length} 台主机
        </span>
        <span>
          <span className={`status-light ${online ? '' : 'offline'}`} />
          {online} 台在线
        </span>
        <small>每台主机独立连接与授权</small>
      </div>
      {hosts.map((host) => (
        <HostSection key={host.id} host={host} breakpoint={breakpoint} openHost={openHost} />
      ))}
      {!hosts.length ? (
        <div className="empty-state">
          <Monitor size={30} />
          <h3>连接第一台主机</h3>
          <p>添加主机后，本机和远端数据会显示在这里</p>
          <Button className="primary" onClick={manage}>
            添加主机
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const HostSection = memo(function HostSection({
  host,
  breakpoint,
  openHost,
}: {
  host: CoreHost;
  breakpoint: Breakpoint;
  openHost: (host: CoreHost) => void;
}) {
  const { state } = host;
  const name = hostName(state);
  const pages = (state.snapshot?.entities || []).filter(
    (entity) => entity.kind === 'page' && !entity.deleted,
  ) as unknown as Entity<Page>[];
  const widgets = (state.snapshot?.entities || []).filter(
    (entity) =>
      entity.kind === 'widget' &&
      !entity.deleted &&
      pages.some((page) => page.id === entity.data.pageId),
  ) as unknown as Entity<Widget>[];
  return (
    <CoreScope value={host.client}>
      <section
        className="aggregate-host"
        data-host-id={host.id}
        data-online={state.online}
        aria-label={'主机 ' + name}
      >
        <header className="aggregate-host-heading">
          <span className="aggregate-host-icon">
            <Monitor size={22} />
          </span>
          <div className="aggregate-host-name">
            <h2>{name}</h2>
            <span>
              {state.endpoint?.uri} <span>·</span> ID {host.id.slice(0, 8)}
            </span>
          </div>
          <span className="aggregate-host-status">
            <span className={`status-light ${state.online ? '' : 'offline'}`} />
            {state.online
              ? '实时同步'
              : state.pairingRequired
                ? '需要重新配对'
                : state.connecting
                  ? '正在连接'
                  : '离线 · 最近快照'}
          </span>
          <Button
            className="secondary"
            disabled={!state.online && !host.active}
            onClick={() => openHost(host)}
          >
            打开工作区
            <ArrowUpRight size={16} />
          </Button>
        </header>
        <div className="aggregate-host-meta">
          <span>{widgets.length} 个组件</span>
          <span>
            <ShieldCheck size={13} />
            {state.device?.role === 'owner'
              ? '所有者'
              : state.device?.role === 'operator'
                ? '操作员'
                : state.device?.role === 'viewer'
                  ? '只读设备'
                  : '离线只读'}
          </span>
          {host.active ? <span>当前管理的主机</span> : null}
        </div>
        {state.error && !state.online ? (
          <p className="aggregate-connection-error" role="status">
            {state.error}
          </p>
        ) : null}
        {pages.map((page) => {
          const items = widgets.filter((widget) => widget.data.pageId === page.id);
          if (!items.length) return null;
          return (
            <div className="aggregate-page" key={page.id}>
              <h3 className="aggregate-page-title">{page.data.title}</h3>
              <div className="aggregate-widget-grid">
                {items.map((widget) => (
                  <AggregateWidget
                    key={widget.id}
                    widget={widget}
                    host={host}
                    name={name}
                    breakpoint={breakpoint}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {!widgets.length ? (
          <div className="aggregate-empty">
            <LayoutDashboard size={22} />
            <p>
              {state.snapshot
                ? '这台主机还没有组件，可打开工作区添加'
                : '等待主机连接后获取工作空间'}
            </p>
          </div>
        ) : null}
      </section>
    </CoreScope>
  );
});

function AggregateWidget({
  widget,
  host,
  name,
  breakpoint,
}: {
  widget: Entity<Widget>;
  host: CoreHost;
  name: string;
  breakpoint: Breakpoint;
}) {
  const [detail, setDetail] = useState(false);
  const state = host.state;
  const topic = `${widget.data.pluginId}/${widget.data.source}`;
  const layout = state.snapshot?.entities.find(
    (entity) =>
      entity.kind === 'layout' &&
      !entity.deleted &&
      entity.data.widgetId === widget.id &&
      entity.data.breakpoint === breakpoint,
  )?.data as Layout | undefined;
  const view = {
    widget: widget.data,
    profile: layout ? widgetProfile(widget.data, layout) : undefined,
    data: state.telemetry[topic]?.value as ViewProps['data'],
    download: state.telemetry[`${widget.data.pluginId}/network.rx`]?.value as number | undefined,
    upload: state.telemetry[`${widget.data.pluginId}/network.tx`]?.value as number | undefined,
    history: state.history[topic] || [],
    rxHistory:
      state.history[
        widget.data.type === 'proxy-status'
          ? topic + '/download'
          : `${widget.data.pluginId}/network.rx`
      ] || [],
    txHistory:
      state.history[
        widget.data.type === 'proxy-status'
          ? topic + '/upload'
          : `${widget.data.pluginId}/network.tx`
      ] || [],
    online: state.online,
  };
  return (
    <>
      <article
        className="widget-card aggregate-widget"
        data-widget-type={widget.data.type}
        data-testid={`aggregate-${host.id}-${widget.id}`}
      >
        <div className="widget-heading">
          <div className="widget-title">
            <Button
              className="widget-detail-trigger"
              aria-label={`查看${name}的${widget.data.title}详情`}
              onClick={() => setDetail(true)}
            >
              <h3>{widget.data.title}</h3>
            </Button>
          </div>
        </div>
        <div className="widget-content">
          <WidgetView {...view} />
        </div>
        <div className="aggregate-widget-source">
          <Monitor size={12} />
          <span>
            {name} · {host.id.slice(0, 8)}
          </span>
          <small>{state.online ? '实时' : '缓存'}</small>
        </div>
      </article>
      {detail ? (
        <Modal title={`${name} · ${widget.data.title}`} close={() => setDetail(false)}>
          <div className="widget-detail-view">
            <WidgetView {...view} expanded />
          </div>
          <p className="subtle">
            {state.endpoint?.uri} · {state.online ? '实时数据' : '离线缓存'}
          </p>
        </Modal>
      ) : null}
    </>
  );
}
