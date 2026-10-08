import { CoreClient, type CoreState } from './core';
import type { Endpoint, SystemInfo } from '../../packages/protocol/src';
import { connectionErrorText } from './connection-errors';

export type CoreHost = { id: string; client: CoreClient; state: CoreState; active: boolean };
export function hostName(state: CoreState) {
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
  constructor(private active: CoreClient) {
    active.beforeActivate = (next) => this.prepareSwitch(next);
    active.subscribe(() => this.sync());
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
