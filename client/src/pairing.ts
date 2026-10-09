export type PairingCode = {
  endpoint: string;
  serverId: string;
  fingerprint: string;
  code: string;
  expiresAt: string;
};
export const loopbackEndpoint = (uri: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(uri).hostname.toLowerCase());
  } catch {
    return false;
  }
};
export function parsePairingCode(text: string, now = Date.now()): PairingCode {
  if (text.length > 4096) throw new Error('不是有效的 Panestra 配对二维码');
  let value: Partial<PairingCode> & { schemaVersion?: number };
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('请扫描电脑 Panestra 中的配对二维码');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
    typeof value.endpoint !== 'string' ||
    typeof value.serverId !== 'string' ||
    !value.serverId ||
    value.serverId.length > 128 ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.fingerprint) ||
    typeof value.code !== 'string' ||
    !/^[A-Za-z0-9_-]{6,128}$/.test(value.code) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new Error('不是有效的 Panestra 配对二维码');
  let url: URL;
  try {
    url = new URL(value.endpoint);
  } catch {
    throw new Error('二维码中的 Core 地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !url.hostname
  )
    throw new Error('二维码需要使用不含凭据的 HTTPS Core 地址');
  if (Date.parse(value.expiresAt) <= now)
    throw new Error('配对二维码已过期，请在电脑重新点击“添加设备”');
  return {
    endpoint: url.origin,
    serverId: value.serverId,
    fingerprint: value.fingerprint.toLowerCase(),
    code: value.code,
    expiresAt: value.expiresAt,
  };
}
