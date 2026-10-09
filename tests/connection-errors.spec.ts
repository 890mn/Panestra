import { test, expect } from '@playwright/test';
import {
  connectionErrorText,
  connectionFailure,
  pairingRequired,
} from '../client/src/connection-errors';

test('连接失败显示真实阶段与原因，不把配对拒绝、TLS 错误和端口拒绝混成一个提示', () => {
  const endpoint = 'https://127.0.0.1:19443';
  const identity = '/api/v1/identity?nonce=test';
  const refused = connectionErrorText(
    connectionFailure(
      'error sending request: tcp connect error: Connection refused (os error 10061)',
      endpoint,
      identity,
      false,
    ),
  );
  expect(refused).toContain('连接端口拒绝请求');
  expect(refused).toContain('验证 Core 身份');
  expect(refused).toContain(endpoint);
  expect(refused).toContain('os error 10061');
  expect(refused).not.toContain('浏览器');
  const tls = connectionErrorText(
    connectionFailure(
      'error sending request: Core identity or certificate validity mismatch',
      endpoint,
      identity,
      false,
    ),
  );
  expect(tls).toContain('身份指纹不匹配');
  expect(tls).not.toContain('连接端口拒绝');
  const browser = connectionErrorText(
    connectionFailure(new TypeError('Failed to fetch'), endpoint, identity, true),
  );
  expect(browser).toContain('当前使用浏览器');
  const pair = connectionErrorText(
    connectionFailure(
      { code: 'REQUEST_FAILED', message: 'pairing closed, expired or remote pairing disabled' },
      endpoint,
      '/api/v1/pairing/request',
      false,
    ),
  );
  expect(pair).toContain('配对码已过期');
  expect(pair).toContain('提交配对请求');
  expect(
    connectionErrorText(
      connectionFailure(
        { code: 'INVALID_CORE_RESPONSE', message: 'HTTP 200' },
        endpoint,
        identity,
        false,
      ),
    ),
  ).toContain('端口是否映射到了其他服务');
  const revoked = connectionFailure(
    { code: 'DEVICE_REVOKED', message: 'device revoked' },
    endpoint,
    '/api/v1/auth/challenge',
    false,
  );
  expect(pairingRequired(revoked)).toBe(true);
  expect(connectionErrorText(revoked)).toContain('授权已被撤销');
});
