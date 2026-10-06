import { test, expect } from '@playwright/test';
import { parsePairingCode } from '../client/src/pairing';
const now = Date.now();
const payload = {
  schemaVersion: 1,
  endpoint: 'https://192.168.1.10:9443',
  serverId: 'core-intended',
  fingerprint: 'a'.repeat(64),
  code: 'PAIRcode1234',
  expiresAt: new Date(now + 120000).toISOString(),
};
test('配对二维码拒绝过期、凭据、非 HTTPS、未知格式及超大输入', () => {
  expect(parsePairingCode(JSON.stringify(payload), now).serverId).toBe('core-intended');
  for (const change of [
    { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: 'bad' },
    { schemaVersion: 2 },
    { endpoint: 'http://192.168.1.10:9443' },
    { endpoint: 'https://user:secret@192.168.1.10:9443' },
    { endpoint: 'https://192.168.1.10:9443/other' },
    { fingerprint: 'bad' },
    { serverId: '' },
    { code: '' },
  ]) {
    expect(() => parsePairingCode(JSON.stringify({ ...payload, ...change }), now)).toThrow();
  }
  expect(() => parsePairingCode('null', now)).toThrow();
  expect(() => parsePairingCode('not a Panestra QR code', now)).toThrow();
  expect(() => parsePairingCode('x'.repeat(4097), now)).toThrow();
});
