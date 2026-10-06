import { get, set } from 'idb-keyval';
import type { Endpoint } from '../../packages/protocol/src';

export const native = '__TAURI_INTERNALS__' in window;
export const canScanPairing = native && /Android/i.test(navigator.userAgent);
export async function openProjectGitHub(): Promise<void> {
  await invoke('plugin:panestra-bridge|open_github');
}
export async function scanPairing(): Promise<string | null> {
  const result = await invoke<{ text: string | null }>('plugin:panestra-bridge|scan_pairing');
  return result.text;
}
if (native)
  (
    window as unknown as { __PANESTRA_NATIVE_EVENT__: (name: string, payload: unknown) => void }
  ).__PANESTRA_NATIVE_EVENT__ = (name, payload) =>
    window.dispatchEvent(new CustomEvent(name, { detail: payload }));
export async function localCoreInfo(): Promise<{
  endpoint: string;
  fingerprint: string;
  bootstrapCode: string;
} | null> {
  if (!native) return null;
  return invoke('local_core_info');
}
const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
};
interface DeviceKey {
  deviceId: string;
  publicKey: string;
  privateKey?: CryptoKey;
}
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export async function deviceKey(): Promise<DeviceKey> {
  if (native) return invoke<DeviceKey>('plugin:panestra-bridge|identity');
  let key = await get<DeviceKey>('panestra.device.v1');
  if (!key) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    key = {
      deviceId: crypto.randomUUID(),
      publicKey: b64(await crypto.subtle.exportKey('spki', pair.publicKey)),
      privateKey: pair.privateKey,
    };
    await set('panestra.device.v1', key);
  }
  return key;
}
export async function sign(message: string): Promise<string> {
  if (native) return invoke<string>('plugin:panestra-bridge|sign', { message });
  const key = await deviceKey();
  return b64(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key.privateKey!,
      new TextEncoder().encode(message),
    ),
  );
}
export async function discover(): Promise<
  Array<{ uri: string; name: string; serverIdHint?: string }>
> {
  const known = (await get<Endpoint[]>('panestra.endpoints.v1')) || [];
  let found: Array<{ uri: string; name: string }> = [];
  if (native) found = await invoke('plugin:panestra-bridge|discover');
  return [
    ...known.map((e) => ({ uri: e.uri, name: '已知 Core', serverIdHint: e.serverId })),
    ...found,
  ].filter((e, i, all) => all.findIndex((v) => v.uri === e.uri) === i);
}
export async function transport<T>(
  endpoint: string,
  path: string,
  init: RequestInit = {},
  fingerprint = '',
): Promise<T> {
  if (native) {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const result = await invoke<{ status: number; body: string }>(
      'plugin:panestra-bridge|request',
      {
        endpoint,
        path,
        method: init.method || 'GET',
        body: typeof init.body === 'string' ? init.body : '',
        headers,
        fingerprint,
      },
    );
    const data = JSON.parse(result.body);
    if (result.status >= 400) throw data;
    return data;
  }
  const response = await fetch(endpoint + path, {
    ...init,
    credentials: 'omit',
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw data;
  return data;
}
export async function realtime(
  endpoint: string,
  fingerprint: string,
  token: string,
  lastServerSeq: number,
  topics: string[],
  message: (data: string) => void,
  closed: () => void,
): Promise<() => void> {
  if (native) {
    const { listen } = await import('@tauri-apps/api/event');
    const connectionId = crypto.randomUUID();
    const offMessage = await listen<{ connectionId: string; data: string }>(
      'panestra:message',
      (e) => {
        if (e.payload.connectionId === connectionId) message(e.payload.data);
      },
    );
    const offClose = await listen<{ connectionId: string }>('panestra:closed', (e) => {
      if (e.payload.connectionId === connectionId) closed();
    });
    const mobileMessage = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data.connectionId === connectionId) message(data.data);
    };
    const mobileClose = (e: Event) => {
      if ((e as CustomEvent).detail.connectionId === connectionId) closed();
    };
    window.addEventListener('panestra:message', mobileMessage);
    window.addEventListener('panestra:closed', mobileClose);
    await invoke('plugin:panestra-bridge|connect', {
      endpoint,
      fingerprint,
      token,
      lastServerSeq,
      topics,
      connectionId,
    });
    return () => {
      offMessage();
      offClose();
      window.removeEventListener('panestra:message', mobileMessage);
      window.removeEventListener('panestra:closed', mobileClose);
      void invoke('plugin:panestra-bridge|disconnect', { connectionId });
    };
  }
  const ws = new WebSocket(endpoint.replace(/^https:/, 'wss:') + '/ws/v1');
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token, lastServerSeq }));
    ws.send(JSON.stringify({ type: 'subscribe', topics }));
  };
  ws.onmessage = (e) => message(e.data);
  ws.onclose = closed;
  return () => {
    ws.onclose = null;
    ws.close();
  };
}
