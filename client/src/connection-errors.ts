import type { APIError } from '../../packages/protocol/src';

export function pairingRequired(error: unknown): boolean {
  const value = error as Partial<APIError> | null;
  return Boolean(
    value &&
    (value.code === 'DEVICE_REVOKED' ||
      value.code === 'DEVICE_NOT_PAIRED' ||
      (value.code === 'REQUEST_FAILED' &&
        (value.message === 'device unavailable' || value.message === 'device revoked'))),
  );
}

export function connectionErrorText(error: unknown): string {
  const value = error as Partial<APIError> | null;
  if (pairingRequired(error))
    return value?.code === 'DEVICE_NOT_PAIRED'
      ? '此设备尚未配对，请在电脑打开配对窗口并批准连接'
      : '此设备的授权已被撤销或已失效，请在电脑打开配对窗口并重新批准连接';
  return value?.message || String(error);
}
