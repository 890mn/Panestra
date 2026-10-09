import { get, set } from 'idb-keyval';
import type { Endpoint } from '../../packages/protocol/src';
import { connectionFailure } from './connection-errors';

export const native = '__TAURI_INTERNALS__' in window;
export const canScanPairing = native && /Android/i.test(navigator.userAgent);
export const desktopNative = native && !/Android/i.test(navigator.userAgent);
export interface DesktopModePreferences {
  startInBackground: boolean;
  closeToBackground: boolean;
}
export const desktopModeInfo = () => invoke<DesktopModePreferences>('desktop_mode_info');
export const configureDesktopMode = (preferences: DesktopModePreferences) =>
  invoke<DesktopModePreferences>('configure_desktop_mode', { preferences });
export const enterBackgroundMode = () => invoke<void>('enter_background_mode');
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
  let status: number;
  let body: string;
  try {
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
      status = result.status;
      body = result.body;
    } else {
      const response = await fetch(endpoint + path, {
        ...init,
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
      });
      status = response.status;
      body = await response.text();
    }
  } catch (error) {
    throw connectionFailure(error, endpoint, path, !native);
  }
  let data: T;
  try {
    data = JSON.parse(body);
  } catch {
    throw connectionFailure(
      { code: 'INVALID_CORE_RESPONSE', message: `HTTP ${status}` },
      endpoint,
      path,
      !native,
    );
  }
  if (status >= 400) throw connectionFailure(data, endpoint, path, !native);
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
