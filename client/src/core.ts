import { get, set } from 'idb-keyval';
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
import {
  SOURCES,
  SYSTEM,
  CODEX_TOPIC,
  CLASH_TOPIC,
  NETEASE_TOPIC,
  ACCOUNT_IDS,
  accountTopic,
} from '../../packages/protocol/src';
import { deviceKey, discover, native, realtime, sign, transport } from './platform';
import { connectionErrorText, pairingRequired } from './connection-errors';

type State = {
  snapshot: Snapshot | null;
  device: Device | null;
  identity: Identity | null;
  endpoint: Endpoint | null;
  online: boolean;
  connecting: boolean;
  pairingRequired: boolean;
  error: string;
  telemetry: Record<string, Telemetry>;
  history: Record<string, number[]>;
};
export class CoreClient {
  state: State = {
    snapshot: null,
    device: null,
    identity: null,
    endpoint: null,
    online: false,
    connecting: false,
    pairingRequired: false,
    error: '',
    telemetry: {},
    history: {},
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
  patch(value: Partial<State>) {
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
      value = { ...value, online: false, snapshot: null, telemetry: {}, history: {} };
    }
    this.state = { ...this.state, ...value };
    this.listeners.forEach((fn) => fn());
  }
  async init() {
    const endpoint = await get<Endpoint>('panestra.active.v1');
    if (endpoint) {
      const snapshot = await get<Snapshot>(`panestra.snapshot.v1:${endpoint.serverId}`);
      this.patch({ endpoint, snapshot: snapshot || null });
      try {
        await this.login();
      } catch (e) {
        this.patch({ error: connectionErrorText(e) });
        this.scheduleReconnect();
      }
    }
  }
  async identity(uri: string, fingerprint: string) {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw { message: '请使用不含凭据的 HTTPS 地址' };
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
        this.patch({ endpoint: { ...prior, uri: verified.uri }, identity: verified.identity });
        await this.acceptSession(session.token, session.device);
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
      this.patch({ endpoint, identity: verified.identity });
      await this.acceptSession(result.token!, result.device!);
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
      this.patch({ endpoint, identity: this.pairingIdentity || this.state.identity });
      this.pairingEndpoint = undefined;
      this.pairingIdentity = undefined;
      await this.acceptSession(result.token, device);
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
          this.patch({ endpoint: candidate });
          try {
            await this.authenticate(true, epoch);
            return;
          } catch (candidateError) {
            if (pairingRequired(candidateError))
              throw candidateError; /* Keep the saved identity pin for every candidate. */
          }
        }
        this.patch({ endpoint: ep });
      }
      throw error;
    } finally {
      this.patch({ connecting: false });
    }
  }
  async acceptSession(token: string, device: Device) {
    this.token = token;
    this.patch({ device, pairingRequired: false, error: '' });
    const ep = this.state.endpoint!;
    await set('panestra.active.v1', ep);
    const known = (await get<Endpoint[]>('panestra.endpoints.v1')) || [];
    await set('panestra.endpoints.v1', [ep, ...known.filter((e) => e.uri !== ep.uri)].slice(0, 8));
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
    return transport<T>(
      ep.uri,
      '/api/v1' + path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ep.publicKeyHash,
    );
  }
  async openRealtime() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopSocket?.();
    const generation = ++this.generation;
    const ep = this.state.endpoint!;
    this.stopSocket = await realtime(
      ep.uri,
      ep.publicKeyHash,
      this.token,
      this.state.snapshot?.serverSeq || 0,
      [
        ...SOURCES.map((s) => `${SYSTEM}/${s}`),
        CODEX_TOPIC,
        CLASH_TOPIC,
        NETEASE_TOPIC,
        ...ACCOUNT_IDS.map(accountTopic),
      ],
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
          const history =
            typeof message.value === 'number'
              ? {
                  ...this.state.history,
                  [topic]: [...(this.state.history[topic] || []), message.value].slice(-60),
                }
              : this.state.history;
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
  }
  scheduleReconnect() {
    if (this.state.pairingRequired || this.reconnectTimer) return;
    const delay = Math.min(
      30000,
      4000 * 2 ** Math.min(this.reconnectAttempt++, 3) * (0.8 + Math.random() * 0.4),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.login().catch((error) => {
        this.patch({ error: connectionErrorText(error) });
        this.scheduleReconnect();
      });
    }, delay);
  }
  resume() {
    if (!this.state.endpoint || this.state.online || this.state.pairingRequired) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    void this.login().catch((error) => {
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
    clearTimeout(this.refreshTimer);
    this.stopSocket?.();
    this.token = '';
    this.patch({ online: false, device: null });
  }
}
export const core = new CoreClient();
