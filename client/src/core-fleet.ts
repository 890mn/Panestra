import { CoreClient, type CoreState } from './core';
import type { Endpoint, SystemInfo } from '../../packages/protocol/src';
import { connectionErrorText } from './connection-errors';
import { coreName } from './core-names';
import type { RelayInfo } from './relay-types';

export type CoreHost = { id: string; client: CoreClient; state: CoreState; active: boolean };
export function hostName(state: CoreState) {
  const name = coreName(state.endpoint?.serverId);
  if (name) return name;
  if (state.endpoint?.relay?.name) return state.endpoint.relay.name;
  const system = Object.values(state.telemetry).find(
    (item) => item.value && typeof item.value === 'object' && 'hostname' in item.value,
  )?.value as SystemInfo | undefined;
  if (system?.hostname) return system.hostname;
  try {
    return new URL(state.endpoint!.uri).host;
  } catch {
    return 'Panestra Core';
  }
}

/** Each trusted Core has its own token, socket, snapshot, plugin permissions and reconnect loop. */
export class CoreFleet {
  private background = new Map<string, { client: CoreClient; unsubscribe: () => void }>();
  private listeners = new Set<() => void>();
  private snapshot: CoreHost[] = [];
  private stopped = false;
  private relayLists = new Map<string, RelayInfo[]>();
  private relayPolling = false;
  constructor(private active: CoreClient) {
    active.resolveHost = (id) => this.find(id);
    active.beforeActivate = (next) => this.prepareSwitch(next);
    active.subscribe(() => this.sync());
    setInterval(() => void this.refreshRelays(), 3000);
  }
  private find(id: string) {
    return this.active.state.endpoint?.serverId === id
      ? this.active
      : this.background.get(id)?.client;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private publish() {
    this.snapshot = [
      ...(this.active.state.endpoint
        ? [
            {
              id: this.active.state.endpoint.serverId,
              client: this.active,
              state: this.active.state,
              active: true,
            },
          ]
        : []),
      ...[...this.background]
        .filter(([id]) => id !== this.active.state.endpoint?.serverId)
        .map(([id, { client }]) => ({ id, client, state: client.state, active: false })),
    ];
    this.listeners.forEach((listener) => listener());
  }
  private create(endpoint: Endpoint) {
    const client = new CoreClient(false);
    client.resolveHost = (id) => this.find(id);
    client.patch({ endpoint, knownEndpoints: this.active.state.knownEndpoints });
    this.background.set(endpoint.serverId, {
      client,
      unsubscribe: client.subscribe(() => this.publish()),
    });
    return client;
  }
  private release(id: string) {
    const entry = this.background.get(id);
    if (!entry) return;
    this.background.delete(id);
    entry.unsubscribe();
    entry.client.disconnect();
  }
  private prepareSwitch(next: Endpoint) {
    this.release(next.serverId);
    const state = this.active.state;
    const old = state.endpoint;
    if (!old || old.serverId === next.serverId || this.stopped) return;
    const client = this.background.get(old.serverId)?.client || this.create(old);
    client.patch({ ...state, switching: false, connecting: false });
    // Reuse this Core's already verified session while its replacement socket starts.
    if (this.active.token && state.device)
      void client.acceptSession(this.active.token, state.device).catch((error) => {
        if (this.background.get(old.serverId)?.client !== client) return;
        client.patch({ online: false, error: connectionErrorText(error) });
        client.scheduleReconnect();
      });
    else void client.connectSaved(old);
  }
  private sync() {
    if (this.stopped) return;
    const current = this.active.state.endpoint;
    if (current) {
      const seen = new Set([current.serverId]);
      for (const endpoint of this.active.state.knownEndpoints) {
        if (endpoint.relay) continue;
        if (seen.has(endpoint.serverId)) continue;
        seen.add(endpoint.serverId);
        if (!this.background.has(endpoint.serverId)) {
          const client = this.create(endpoint);
          void client.connectSaved(endpoint);
        }
      }
    }
    this.publish();
  }
  async refreshRelays() {
    if (this.stopped || this.relayPolling) return;
    this.relayPolling = true;
    try {
      const gateways = [
        this.active,
        ...[...this.background.values()].map((entry) => entry.client),
      ].filter(
        (client) =>
          client.state.online &&
          !client.state.endpoint?.relay &&
          client.state.identity?.capabilities?.includes('core-relay'),
      );
      await Promise.all(
        gateways.map(async (gateway) => {
          const id = gateway.state.endpoint!.serverId;
          try {
            const list = await gateway.api<RelayInfo[]>('/relays');
            if (gateway.state.endpoint?.serverId === id && !gateway.state.endpoint.relay)
              this.relayLists.set(id, list);
          } catch {
            /* Offline gateway state is handled by its delegated clients. */
          }
        }),
      );
      const direct = new Set(
        [this.active, ...[...this.background.values()].map((entry) => entry.client)]
          .filter((client) => client.state.online && !client.state.endpoint?.relay)
          .map((client) => client.state.endpoint!.serverId),
      );
      const desired = new Map<string, Endpoint>();
      for (const [gatewayId, routes] of this.relayLists) {
        if (!this.find(gatewayId)) continue;
        for (const route of routes) {
          if (
            !route.role ||
            direct.has(route.serverId) ||
            route.serverId === gatewayId ||
            desired.has(route.serverId)
          )
            continue;
          desired.set(route.serverId, {
            uri: route.uri,
            serverId: route.serverId,
            publicKeyHash: route.fingerprint,
            priority: 1,
            relay: { gatewayId, routeId: route.id, name: route.name },
          });
        }
      }
      for (const [id, { client }] of this.background) {
        if (client.state.endpoint?.relay && !desired.has(id)) this.release(id);
      }
      for (const [id, ep] of desired) {
        const existing = this.find(id);
        if (!existing) void this.create(ep).connectSaved(ep);
        else if (!existing.state.endpoint?.relay) {
          const route = this.relayLists
            .get(ep.relay!.gatewayId)
            ?.find((route) => route.id === ep.relay!.routeId);
          if (existing.state.online || !route?.online) continue;
          if (existing !== this.active) {
            this.release(id);
            void this.create(ep).connectSaved(ep);
          } else if (!this.active.state.switching)
            await this.active.switchEndpoint(ep).catch(() => {});
        } else if (existing.state.endpoint?.relay?.gatewayId !== ep.relay!.gatewayId) {
          if (existing !== this.active) {
            this.release(id);
            void this.create(ep).connectSaved(ep);
          } else if (!this.active.state.switching)
            await this.active.switchEndpoint(ep).catch(() => {});
        } else if (existing.state.endpoint.relay?.name !== ep.relay!.name)
          existing.patch({ endpoint: ep });
      }
      const ep = this.active.state.endpoint;
      if (ep?.relay && !desired.has(ep.serverId)) {
        this.active.patch({
          online: false,
          snapshot: null,
          telemetry: {},
          history: {},
          plugins: [],
          device: null,
          error: '中转授权已移除，请选择其他主机',
        });
        const gateway = this.find(ep.relay.gatewayId);
        if (gateway?.state.online && gateway.state.endpoint)
          await this.active.switchEndpoint(gateway.state.endpoint).catch(() => {});
      }
      this.publish();
    } finally {
      this.relayPolling = false;
    }
  }
  resume() {
    this.active.resume();
    for (const { client } of this.background.values()) client.resume();
  }
  disconnectAll() {
    this.stopped = true;
    for (const id of [...this.background.keys()]) this.release(id);
    this.active.disconnect();
    this.publish();
  }
}
