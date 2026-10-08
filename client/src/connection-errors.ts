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
  const message = value?.message || String(error);
  if (/Core identity|certificate validity|身份指纹不匹配/i.test(message))
    return 'Core 身份指纹不匹配或证书已失效，请核对目标主机和系统时间；连接另一台主机请选择「添加新 Core」';
  if (
    /Failed to fetch|NetworkError|error sending request|timed out|timeout|Connection refused|actively refused/i.test(
      message,
    )
  )
    return '无法连接 Core，请检查主机是否运行、端口映射是否开启以及目标地址是否正确；浏览器还需满足证书与来源限制';
  return message;
}
