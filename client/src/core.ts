import { get, set, update } from 'idb-keyval';
import { CoreFleet } from './core-fleet';
import type {
  APIError,
  CanonicalEvent,
  Command,
  Device,
  Endpoint,
  Entity,
  Identity,
  Snapshot,
  Telemetry,
} from '../../packages/protocol/src';
import type { Plugin } from '../../packages/protocol/src';
import type { PluginManifest } from './plugin-schema';
import { deviceKey, discover, native, realtime, sign, transport } from './platform';
import { connectionErrorText, pairingRequired } from './connection-errors';
import { loadCoreNames } from './core-names';

export type CoreState = {
  snapshot: Snapshot | null;
  device: Device | null;
  identity: Identity | null;
  endpoint: Endpoint | null;
  online: boolean;
  connecting: boolean;
  switching: boolean;
  knownEndpoints: Endpoint[];
  pairingRequired: boolean;
  error: string;
  telemetry: Record<string, Telemetry>;
  history: Record<string, number[]>;
  plugins: InstalledPlugin[];
};
export type InstalledPlugin = Plugin & { manifest: PluginManifest; enabled: boolean };
export class CoreClient {
  constructor(readonly persistActive = true) {}
  beforeActivate?: (endpoint: Endpoint) => void;
  state: CoreState = {
    snapshot: null,
    device: null,
    identity: null,
    endpoint: null,
    online: false,
    connecting: false,
    switching: false,
    knownEndpoints: [],
    pairingRequired: false,
    error: '',
    telemetry: {},
    history: {},
    plugins: [],
  };
  listeners = new Set<() => void>();
  token = '';
  stopSocket?: () => void;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  cacheTimer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  generation = 0;
  private loginTask?: Promise<void>;
  private sessionEpoch = 0;
  private reconnectAttempt = 0;
  pairingEndpoint?: Endpoint;
  pairingIdentity?: Identity;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;
  patch(value: Partial<CoreState>) {
    // A newly accepted Core must never inherit another computer's quota or metrics.
    if (
      value.endpoint &&
      this.state.endpoint &&
      value.endpoint.serverId !== this.state.endpoint.serverId
    ) {
      ++this.generation;
      ++this.sessionEpoch;
      this.stopSocket?.();
      clearTimeout(this.cacheTimer);
      clearTimeout(this.refreshTimer);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.token = '';
      this.loginTask = undefined;
      value = {
        online: false,
        device: null,
        identity: null,
        snapshot: null,
        telemetry: {},
        history: {},
        plugins: [],
        ...value,
      };
    }
    this.state = { ...this.state, ...value };
    this.listeners.forEach((fn) => fn());
  }
  async init() {
    await loadCoreNames();
    const epoch = this.sessionEpoch;
    const [endpoint, known] = await Promise.all([
      get<Endpoint>('panestra.active.v1'),
      get<Endpoint[]>('panestra.endpoints.v1'),
    ]);
    if (epoch !== this.sessionEpoch) return;
    this.patch({ knownEndpoints: known || (endpoint ? [endpoint] : []) });
    if (endpoint) {
      await this.connectSaved(endpoint);
    }
  }
  async connectSaved(endpoint: Endpoint) {
    const epoch = this.sessionEpoch;
    const [snapshot, plugins] = await Promise.all([
      get<Snapshot>('panestra.snapshot.v1:' + endpoint.serverId),
      get<InstalledPlugin[]>('panestra.plugins.v1:' + endpoint.serverId),
    ]);
    if (epoch !== this.sessionEpoch) return;
    this.patch({ endpoint, snapshot: snapshot || null, plugins: plugins || [] });
    try {
      await this.login();
    } catch (e) {
      if (epoch !== this.sessionEpoch) return;
      this.patch({ error: connectionErrorText(e) });
      this.scheduleReconnect();
    }
  }
  async switchEndpoint(candidate: Endpoint) {
    if (this.state.switching) throw { message: '正在切换 Core，请稍后重试' };
    const known =
      this.state.knownEndpoints.find((item) => item.serverId === candidate.serverId) ||
      (this.state.endpoint?.serverId === candidate.serverId ? this.state.endpoint : undefined);
    if (!known || known.publicKeyHash !== candidate.publicKeyHash)
      throw { message: '请先配对此 Core，再切换连接' };
    let url: URL;
    try {
      url = new URL(candidate.uri);
    } catch {
      throw { message: '请填写完整的 HTTPS 地址，例如 https://127.0.0.1:19443' };
    }
    if (url.pathname !== '/' || url.search || url.hash)
      throw { message: 'Core 地址只填写 HTTPS 主机和端口，不包含路径' };
    this.patch({ switching: true });
    try {
      // Verify and authenticate the candidate before replacing the current connection.
      const { identity, uri } = await this.identity(candidate.uri, known.publicKeyHash);
      if (identity.serverId !== known.serverId) throw { message: '连接地址对应的 Core 身份不匹配' };
      const key = await deviceKey();
      const challenge = await transport<{ id: string; message: string }>(
        uri,
        '/api/v1/auth/challenge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: key.deviceId,
            publicKey: key.publicKey,
            purpose: 'login',
          }),
        },
        known.publicKeyHash,
      );
      const result = await transport<{ token: string; device: Device }>(
        uri,
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challengeId: challenge.id,
            signature: await sign(challenge.message),
          }),
        },
        known.publicKeyHash,
      );
      await this.activateSession(
        { ...candidate, uri, lastSuccess: new Date().toISOString() },
        identity,
        result.token,
        result.device,
      );
    } finally {
      this.patch({ switching: false });
    }
  }
  private async activateSession(
    endpoint: Endpoint,
    identity: Identity,
    token: string,
    device: Device,
  ) {
    const old = this.state.endpoint;
    if (old?.uri !== endpoint.uri || old?.serverId !== endpoint.serverId) {
      if (old && this.state.snapshot)
        await set('panestra.snapshot.v1:' + old.serverId, this.state.snapshot);
      const [snapshot, plugins] = await Promise.all([
        get<Snapshot>('panestra.snapshot.v1:' + endpoint.serverId),
        get<InstalledPlugin[]>('panestra.plugins.v1:' + endpoint.serverId),
      ]);
      this.beforeActivate?.(endpoint);
      this.disconnect();
      this.patch({ endpoint, identity });
      this.patch({
        snapshot: snapshot || null,
        plugins: plugins || [],
        telemetry: {},
        history: {},
        error: '',
        pairingRequired: false,
      });
    } else this.patch({ endpoint, identity });
    await this.acceptSession(token, device);
  }
  async identity(uri: string, fingerprint: string) {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw { message: '请使用不含凭据的 HTTPS 地址' };
    if (url.pathname !== '/' || url.search || url.hash)
      throw { message: 'Core 地址只填写 HTTPS 主机和端口，不包含路径' };
    if (!/^[0-9a-f]{64}$/i.test(fingerprint))
      throw { message: '请填写本机 Core 显示的 64 位身份指纹' };
    const nonce = crypto.randomUUID();
    const identity = await transport<Identity>(
      url.origin,
      '/api/v1/identity?nonce=' + nonce,
      {},
      fingerprint,
    );
    if (
      identity.apiVersion !== 1 ||
      identity.fingerprint.toLowerCase() !== fingerprint.toLowerCase()
    )
      throw { message: 'Core 身份指纹不匹配，连接已拒绝' };
    const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    if (
      !identity.publicKey ||
      !identity.signature ||
      identity.proof !== `panestra:server:v1:${nonce}:${identity.serverId}`
    )
      throw { message: 'Core 未提供有效的身份签名' };
    const publicKey = bytes(identity.publicKey);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== fingerprint.toLowerCase()) throw { message: 'Core 公钥与身份指纹不匹配' };
    const key = await crypto.subtle.importKey(
      'spki',
      publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        bytes(identity.signature),
        new TextEncoder().encode(identity.proof),
      ))
    )
      throw { message: 'Core 身份签名验证失败' };
    return { identity, uri: url.origin };
  }
  async claim(
    uri: string,
    fingerprint: string,
    code: string,
    name: string,
    bootstrap: boolean,
    expectedServerId?: string,
  ) {
    const verified = await this.identity(uri, fingerprint);
    if (expectedServerId && expectedServerId !== verified.identity.serverId)
      throw { message: '二维码中的 Core 身份与实际服务器不一致' };
    const known = (await get<Endpoint[]>('panestra.endpoints.v1')) || [];
    const prior =
      known.find((endpoint) => endpoint.serverId === verified.identity.serverId) ||
      (this.state.endpoint?.serverId === verified.identity.serverId
        ? this.state.endpoint
        : undefined);
    if (prior && prior.publicKeyHash !== fingerprint.toLowerCase())
      throw { message: '已配对 Core 的公钥发生变化，连接已拒绝' };
    const key = await deviceKey();
    if (!bootstrap && prior) {
      try {
        const challenge = await transport<{ id: string; message: string }>(
          verified.uri,
          '/api/v1/auth/challenge',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: key.deviceId,
              publicKey: key.publicKey,
              purpose: 'login',
            }),
          },
          fingerprint,
        );
        const session = await transport<{ token: string; device: Device }>(
          verified.uri,
          '/api/v1/auth/login',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              challengeId: challenge.id,
              signature: await sign(challenge.message),
            }),
          },
          fingerprint,
        );
        await this.activateSession(
          { ...prior, uri: verified.uri },
          verified.identity,
          session.token,
          session.device,
        );
        return;
      } catch (error) {
        // Only an explicit missing/revoked-device response permits a NEW pairing
        // request. TLS/identity/signature/network failures never bypass login.
        if (!pairingRequired(error)) throw error;
      }
    }
    const challenge = await transport<{ id: string; message: string }>(
      verified.uri,
      '/api/v1/auth/challenge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: key.deviceId,
          publicKey: key.publicKey,
          purpose: bootstrap ? 'bootstrap' : 'pair',
        }),
      },
      fingerprint,
    );
    const payload = {
      code,
      name,
      challengeId: challenge.id,
      signature: await sign(challenge.message),
    };
    const result = await transport<{ token?: string; id?: string; device?: Device }>(
      verified.uri,
      bootstrap ? '/api/v1/auth/bootstrap' : '/api/v1/pairing/request',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      fingerprint,
    );
    const endpoint: Endpoint = {
      uri: verified.uri,
      serverId: verified.identity.serverId,
      publicKeyHash: fingerprint.toLowerCase(),
      priority: 0,
      lastSuccess: new Date().toISOString(),
    };
    if (bootstrap) {
      await this.activateSession(endpoint, verified.identity, result.token!, result.device!);
    } else {
      this.pairingEndpoint = endpoint;
      this.pairingIdentity = verified.identity;
    }
    return result.id;
  }
  async pollPair(id: string) {
    const endpoint = this.pairingEndpoint || this.state.endpoint!;
    const result = await transport<{ status: string; token: string }>(
      endpoint.uri,
      `/api/v1/pairing/status/${id}`,
      {},
      endpoint.publicKeyHash,
    );
    if (result.status === 'approved') {
      const device = await transport<Device>(
        endpoint.uri,
        '/api/v1/me',
        { headers: { Authorization: 'Bearer ' + result.token } },
        endpoint.publicKeyHash,
      );
      const identity = this.pairingIdentity || this.state.identity!;
      this.pairingEndpoint = undefined;
      this.pairingIdentity = undefined;
      await this.activateSession(endpoint, identity, result.token, device);
    }
    if (result.status === 'denied') throw { message: 'Core 已拒绝此次配对' };
    return result.status;
  }
  login() {
    // Resume, retry and the refresh timer can fire together. Share one handshake.
    if (this.loginTask) return this.loginTask;
    const task = this.authenticate(false, this.sessionEpoch).finally(() => {
      if (this.loginTask === task) this.loginTask = undefined;
    });
    this.loginTask = task;
    return task;
  }
  private async authenticate(alternative: boolean, epoch: number) {
    const ep = this.state.endpoint;
    if (!ep) return;
    this.patch({ connecting: true });
    const started = performance.now();
    try {
      const { identity } = await this.identity(ep.uri, ep.publicKeyHash);
      if (identity.serverId !== ep.serverId) throw { message: '已保存 Core 的身份发生变化' };
      const key = await deviceKey();
      const challenge = await transport<{ id: string; message: string }>(
        ep.uri,
        '/api/v1/auth/challenge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: key.deviceId,
            publicKey: key.publicKey,
            purpose: 'login',
          }),
        },
        ep.publicKeyHash,
      );
      const result = await transport<{ token: string; device: Device }>(
        ep.uri,
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challengeId: challenge.id,
            signature: await sign(challenge.message),
          }),
        },
        ep.publicKeyHash,
      );
      if (epoch !== this.sessionEpoch) return;
      this.patch({
        identity,
        endpoint: {
          ...ep,
          lastSuccess: new Date().toISOString(),
          lastRTT: Math.round(performance.now() - started),
        },
      });
      await this.acceptSession(result.token, result.device);
    } catch (error) {
      if (epoch !== this.sessionEpoch) return;
      if (pairingRequired(error)) {
        this.disconnect();
        this.patch({ pairingRequired: true, error: connectionErrorText(error) });
        throw error;
      }
      if (!alternative && (error as APIError).code !== 'UNAUTHORIZED') {
        const known = ((await get<Endpoint[]>('panestra.endpoints.v1')) || [])
          .filter((candidate) => candidate.serverId === ep.serverId && candidate.uri !== ep.uri)
          .sort((a, b) => a.priority - b.priority);
        if (native) {
          const candidates = await discover().catch(() => []);
          for (const candidate of candidates)
            if (
              candidate.serverIdHint === ep.serverId &&
              candidate.uri !== ep.uri &&
              !known.some((item) => item.uri === candidate.uri)
            )
              known.push({ ...ep, uri: candidate.uri });
        }
        for (const candidate of known.slice(0, 8)) {
          if (epoch !== this.sessionEpoch) return;
          this.patch({ endpoint: candidate });
          try {
            await this.authenticate(true, epoch);
            return;
          } catch (candidateError) {
            if (epoch !== this.sessionEpoch) return;
            if (pairingRequired(candidateError))
              throw candidateError; /* Keep the saved identity pin for every candidate. */
          }
        }
        if (epoch !== this.sessionEpoch) return;
        this.patch({ endpoint: ep });
      }
      throw error;
    } finally {
      if (epoch === this.sessionEpoch) this.patch({ connecting: false });
    }
  }
  async acceptSession(token: string, device: Device) {
    const epoch = this.sessionEpoch;
    this.token = token;
    this.patch({ device, pairingRequired: false, error: '' });
    const ep = this.state.endpoint!;
    if (this.persistActive) await set('panestra.active.v1', ep);
    if (epoch !== this.sessionEpoch) return;
    await update<Endpoint[]>('panestra.endpoints.v1', (known = []) =>
      [ep, ...known.filter((e) => e.uri !== ep.uri)].slice(0, 32),
    );
    const endpoints = (await get<Endpoint[]>('panestra.endpoints.v1')) || [ep];
    if (epoch !== this.sessionEpoch) return;
    this.patch({ knownEndpoints: endpoints });
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => {
        void this.login().catch(() => this.scheduleReconnect());
      },
      12 * 60 * 1000,
    );
    await this.openRealtime();
  }
  async api<T>(path: string, body?: unknown): Promise<T> {
    const ep = this.state.endpoint;
    if (!ep) throw { message: '请先连接 Core' };
    const epoch = this.sessionEpoch;
    const result = await transport<T>(
      ep.uri,
      '/api/v1' + path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ep.publicKeyHash,
    );
    if (epoch !== this.sessionEpoch) throw { message: 'Core 已切换，旧连接的操作已取消' };
    return result;
  }
  async loadPlugins() {
    const plugins = await this.api<InstalledPlugin[]>('/plugins');
    const installed = new Set(
      plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
    );
    this.patch({
      plugins,
      telemetry: Object.fromEntries(
        Object.entries(this.state.telemetry).filter(([topic]) =>
          installed.has(topic.split('/')[0]),
        ),
      ),
      history: Object.fromEntries(
        Object.entries(this.state.history).filter(([topic]) => installed.has(topic.split('/')[0])),
      ),
    });
    const ep = this.state.endpoint!;
    await set('panestra.plugins.v1:' + ep.serverId, plugins);
  }
  async pluginRequest<T>(id: string, operation: string, body?: unknown): Promise<T> {
    const route = this.state.plugins
      .find((plugin) => plugin.id === id)
      ?.manifest.routes?.find((route) => route.operation === operation);
    if (!route) throw { message: '插件不支持此操作' };
    return this.api<T>(route.path, route.method === 'GET' ? undefined : body || {});
  }
  async openRealtime() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopSocket?.();
    const generation = ++this.generation;
    const ep = this.state.endpoint!;
    await this.loadPlugins();
    if (generation !== this.generation) return;
    const stop = await realtime(
      ep.uri,
      ep.publicKeyHash,
      this.token,
      this.state.snapshot?.serverSeq || 0,
      this.state.plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) => plugin.manifest.sources.map((source) => `${plugin.id}/${source.id}`)),
      (data) => {
        if (generation !== this.generation) return;
        const message = JSON.parse(data) as Snapshot | CanonicalEvent | Telemetry;
        if (message.type === 'snapshot') {
          this.reconnectAttempt = 0;
          this.patch({ snapshot: message, online: true, error: '' });
          this.cache();
        } else if (message.type === 'event') this.apply(message);
        else if (message.type === 'telemetry') {
          const topic = message.topic;
          let history =
            typeof message.value === 'number'
              ? {
                  ...this.state.history,
                  [topic]: [...(this.state.history[topic] || []), message.value].slice(-60),
                }
              : this.state.history;
          if (
            message.value !== null &&
            typeof message.value === 'object' &&
            'groups' in message.value
          ) {
            const value = message.value;
            const previous = this.state.telemetry[topic]?.value;
            if (
              value.state === 'ready' &&
              !value.stale &&
              !value.refreshing &&
              value.updatedAt !==
                (typeof previous === 'object' && 'groups' in previous
                  ? previous.updatedAt
                  : undefined)
            ) {
              history = { ...history };
              for (const [key, rate] of [
                ['download', value.download],
                ['upload', value.upload],
              ] as const) {
                if (rate !== null && Number.isFinite(rate))
                  history[`${topic}/${key}`] = [
                    ...(history[`${topic}/${key}`] || []),
                    rate / 1024,
                  ].slice(-30);
              }
            }
          }
          this.patch({ telemetry: { ...this.state.telemetry, [topic]: message }, history });
        }
      },
      () => {
        if (generation === this.generation) {
          this.patch({ online: false, error: '连接已断开，正在自动重连，离线时工作空间只读' });
          this.scheduleReconnect();
        }
      },
    );
    if (generation !== this.generation) stop();
    else this.stopSocket = stop;
  }
  scheduleReconnect() {
    if (this.state.pairingRequired || this.reconnectTimer) return;
    const delay = Math.min(
      30000,
      4000 * 2 ** Math.min(this.reconnectAttempt++, 3) * (0.8 + Math.random() * 0.4),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const epoch = this.sessionEpoch;
      void this.login().catch((error) => {
        if (epoch !== this.sessionEpoch) return;
        this.patch({ error: connectionErrorText(error) });
        this.scheduleReconnect();
      });
    }, delay);
  }
  resume() {
    if (!this.state.endpoint || this.state.online || this.state.pairingRequired) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const epoch = this.sessionEpoch;
    void this.login().catch((error) => {
      if (epoch !== this.sessionEpoch) return;
      this.patch({ error: connectionErrorText(error) });
      this.scheduleReconnect();
    });
  }
  apply(event: CanonicalEvent) {
    const snapshot = this.state.snapshot;
    if (!snapshot || event.serverSeq <= snapshot.serverSeq) return;
    if (event.serverSeq !== snapshot.serverSeq + 1) {
      void this.api<Snapshot>('/snapshot').then((snapshot) => {
        this.patch({ snapshot });
        this.cache();
      });
      return;
    }
    let entities = snapshot.entities;
    for (const entity of event.entities || [event.entity]) {
      entities = entities.filter((e) => e.id !== entity.id || e.kind !== entity.kind);
      if (entity.deleted) {
        const childIds = new Set(
          entities
            .filter((e) => e.kind === 'widget' && e.data.pageId === entity.id)
            .map((e) => e.id),
        );
        entities = entities.map((e) =>
          (e.kind === 'widget' && childIds.has(e.id)) ||
          (e.kind === 'layout' &&
            (e.data.widgetId === entity.id || childIds.has(String(e.data.widgetId))))
            ? { ...e, deleted: true }
            : e,
        );
      }
      entities = [...entities, entity];
    }
    this.patch({ snapshot: { ...snapshot, serverSeq: event.serverSeq, entities } });
    this.cache();
  }
  cache() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      if (this.state.endpoint && this.state.snapshot)
        void set(`panestra.snapshot.v1:${this.state.endpoint.serverId}`, this.state.snapshot);
    }, 250);
  }
  async command(entity: Entity | { id: string; rev: number }, command: string, payload: unknown) {
    if (!this.state.online) throw { message: 'Core 离线，编辑将在重连后恢复' };
    const c: Command = {
      opId: crypto.randomUUID(),
      deviceId: this.state.device!.id,
      entityId: entity.id,
      baseRev: entity.rev,
      command,
      payload,
    };
    try {
      const event = await this.api<CanonicalEvent>('/commands', c);
      this.apply(event);
      return event;
    } catch (e) {
      const error = e as APIError;
      const current = error.currentState;
      // Only rebase disjoint scalar configuration fields. Layouts and deletion need review.
      if (
        error.code === 'REVISION_CONFLICT' &&
        current &&
        !current.deleted &&
        'data' in entity &&
        command.endsWith('.update') &&
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
      ) {
        const fields = Object.keys(payload);
        if (
          fields.length &&
          fields.every(
            (field) => JSON.stringify(entity.data[field]) === JSON.stringify(current.data[field]),
          )
        ) {
          const event = await this.api<CanonicalEvent>('/commands', {
            ...c,
            opId: crypto.randomUUID(),
            baseRev: current.rev,
          });
          this.apply(event);
          return event;
        }
      }
      if (current) {
        const snapshot = await this.api<Snapshot>('/snapshot');
        this.patch({ snapshot });
        this.cache();
      }
      throw error;
    }
  }
  disconnect() {
    ++this.generation;
    ++this.sessionEpoch;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
    this.loginTask = undefined;
    clearTimeout(this.cacheTimer);
    clearTimeout(this.refreshTimer);
    this.stopSocket?.();
    this.token = '';
    this.patch({ online: false, connecting: false, device: null });
  }
}
export const core = new CoreClient();
export const coreFleet = new CoreFleet(core);
