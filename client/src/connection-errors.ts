import type { APIError } from '../../packages/protocol/src';

type ConnectionFailure = Partial<APIError> & {
  connection?: { endpoint: string; path: string; browser: boolean };
};

export function connectionFailure(
  error: unknown,
  endpoint: string,
  path: string,
  browser: boolean,
): ConnectionFailure {
  const value = error as Partial<APIError> | null;
  const message = value?.message || String(error);
  return {
    code: value?.code || 'CONNECTION_FAILED',
    message,
    connection: { endpoint, path, browser },
  };
}

const phase = (path: string) =>
  path.startsWith('/api/v1/identity')
    ? '验证 Core 身份'
    : path.endsWith('/auth/challenge')
      ? '获取认证挑战'
      : path.endsWith('/pairing/request')
        ? '提交配对请求'
        : path.includes('/pairing/status/')
          ? '等待主机批准'
          : path.endsWith('/auth/login')
            ? '登录已配对设备'
            : '读取 Core 数据';

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
  const value = error as ConnectionFailure | null;
  if (pairingRequired(error))
    return value?.code === 'DEVICE_NOT_PAIRED'
      ? '此设备尚未配对，请在电脑打开配对窗口并批准连接'
      : '此设备的授权已被撤销或已失效，请在电脑打开配对窗口并重新批准连接';
  const message = value?.message || String(error);
  let text = message;
  if (/Core identity|certificate validity|身份指纹不匹配/i.test(message))
    text = 'Core 身份指纹不匹配或证书已失效，请核对目标主机的 SHA-256 与系统时间';
  else if (/Connection refused|actively refused|ECONNREFUSED|os error 10061/i.test(message))
    text = '连接端口拒绝请求，请检查该端口是否有 Core 或映射服务监听';
  else if (/timed out|timeout|ETIMEDOUT/i.test(message))
    text = '连接 Core 超时，请检查远端主机和端口映射是否在线';
  else if (/dns error|failed to lookup|No such host|ENOTFOUND|UnknownHost/i.test(message))
    text = '无法解析 Core 主机地址，请核对主机名或使用映射服务提供的地址';
  else if (/tls|ssl|certificate|handshake/i.test(message))
    text = 'Core 的 TLS 连接未通过，请确认映射转发的是 Core HTTPS 端口';
  else if (value?.code === 'INVALID_CORE_RESPONSE')
    text = '该地址没有返回有效的 Core 数据，请检查端口是否映射到了其他服务';
  else if (/pairing closed, expired or remote pairing disabled/i.test(message))
    text = '配对窗口已关闭、配对码已过期或未允许远程配对，请在目标主机重新打开添加设备';
  else if (/Failed to fetch|NetworkError|error sending request/i.test(message))
    text = '无法连接 Core，请检查目标地址和端口映射';
  if (!value?.connection) return text;
  const { endpoint, path, browser } = value.connection;
  const hint =
    browser && /Failed to fetch|NetworkError/i.test(message)
      ? '\n当前使用浏览器，请先打开目标地址检查证书；跨主机连接建议使用 Windows 安装版'
      : '';
  // Transport errors contain a cause, never the request body, pairing code or token.
  const detail =
    value.code === 'CONNECTION_FAILED' && text !== message && !browser
      ? '\n原因：' + message.slice(0, 800)
      : '';
  return `${text}\n${phase(path)} · ${endpoint}${hint}${detail}`;
}
