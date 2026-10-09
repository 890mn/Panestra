import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, '.tools/native-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/native-tests/fleet-'));
const remote = spawn(
  path.join(root, 'artifacts/panestra-core.exe'),
  [
    '--data',
    path.join(data, 'remote'),
    '--listen',
    '127.0.0.1:19527',
    '--plugin-seed',
    path.join(root, 'artifacts/plugin-seed'),
    '--parent-stdio',
  ],
  { windowsHide: true },
);
const sockets = new Set();
let browser, app, tunnel;
try {
  const target = await new Promise((resolve, reject) => {
    let bootstrap = '',
      fingerprint = '',
      stderr = '';
    const timer = setTimeout(
      () => reject(new Error('Isolated remote Core startup timed out')),
      15000,
    );
    const ready = () => {
      if (bootstrap && fingerprint) {
        clearTimeout(timer);
        resolve({ bootstrap, fingerprint });
      }
    };
    remote.stdout.on('data', (data) => {
      bootstrap = data.toString().match(/认领码[^:]+: (\S+)/)?.[1] || bootstrap;
      ready();
    });
    remote.stderr.on('data', (data) => {
      stderr += data.toString();
      for (const line of stderr.split('\n')) {
        try {
          const log = JSON.parse(line);
          if (log.msg === 'Panestra Core ready') fingerprint = log.fingerprint;
        } catch {}
      }
      ready();
    });
    remote.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Isolated remote Core exited'));
    });
  });
  // Independent owner of the isolated target; all keys/codes stay in memory.
  const ownerKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ownerId = randomUUID();
  const remoteAPI = (apiPath, body, token = '') =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        `https://127.0.0.1:19527/api/v1${apiPath}`,
        {
          method: body ? 'POST' : 'GET',
          rejectUnauthorized: false,
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (response) => {
          const certificate = response.socket.getPeerX509Certificate();
          if (!certificate) {
            response.destroy();
            reject(new Error('Isolated fixture certificate missing'));
            return;
          }
          const fingerprint = createHash('sha256')
            .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
            .digest('hex');
          if (fingerprint !== target.fingerprint) {
            response.destroy();
            reject(new Error('Isolated fixture TLS pin mismatch'));
            return;
          }
          let text = '';
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            const value = JSON.parse(text);
            if (response.statusCode >= 400) reject(new Error(value.message));
            else resolve(value);
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Isolated fixture request timed out')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const challenge = await remoteAPI('/auth/challenge', {
    deviceId: ownerId,
    publicKey: ownerKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    purpose: 'bootstrap',
  });
  const owner = await remoteAPI('/auth/bootstrap', {
    code: target.bootstrap,
    name: 'Remote owner fixture',
    challengeId: challenge.id,
    signature: sign('sha256', Buffer.from(challenge.message), {
      key: ownerKeys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64'),
  });
  const pairing = await remoteAPI('/pairing/window', { remote: true }, owner.token);
  tunnel = createServer((local) => {
    const upstream = connect(19527, '127.0.0.1');
    for (const socket of [local, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        local.destroy();
        upstream.destroy();
      });
    }
    local.pipe(upstream);
    upstream.pipe(local);
  });
  await new Promise((resolve) => tunnel.listen(19528, '127.0.0.1', resolve));
  const executable = path.join(root, 'shell/desktop/target/release/panestra-desktop.exe');
  app = spawn(executable, [], {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: {
      ...process.env,
      PANESTRA_DATA_DIR: path.join(data, 'local'),
      PANESTRA_CORE_LISTEN: '127.0.0.1:19525',
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19526',
      HTTP_PROXY: 'http://127.0.0.1:19699',
      HTTPS_PROXY: 'http://127.0.0.1:19699',
      ALL_PROXY: 'http://127.0.0.1:19699',
      NO_PROXY: '',
    },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:19526');
      break;
    } catch {
      if (app.exitCode !== null) throw new Error('Isolated native app exited');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) throw new Error('Isolated WebView2 debugger did not start');
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = context.pages().find((item) => item.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error('Isolated native page not found');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(
    () => document.querySelector('.fingerprint-input')?.value.length === 64,
  );
  await page.getByRole('button', { name: '建立并进入工作空间', exact: true }).click();
  await expect(page.locator('.aggregate-host')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('.aggregate-host')).toHaveAttribute('data-online', 'true');
  await page.getByRole('button', { name: '管理 Core 连接', exact: true }).click();
  await page.getByRole('button', { name: '添加新 Core', exact: true }).click();
  await expect(page.getByLabel('Core 地址', { exact: true })).toHaveValue('');
  await page.getByLabel('Core 地址', { exact: true }).fill('https://127.0.0.1:19529');
  await page.getByLabel('Core 身份指纹').fill(target.fingerprint);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('连接端口拒绝请求');
  await expect(page.getByRole('alert')).toContainText('验证 Core 身份');
  await expect(page.getByRole('alert')).not.toContainText('当前使用浏览器');
  await page.getByLabel('Core 地址', { exact: true }).fill('https://127.0.0.1:19528');
  await page.getByLabel('Core 身份指纹').fill('0'.repeat(64));
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('身份指纹不匹配');
  await page.getByLabel('Core 身份指纹').fill(target.fingerprint);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.locator('.connection-test-result')).toContainText('已连接并验证 Core 身份');
  expect(await remoteAPI('/pairing/pending', undefined, owner.token)).toEqual([]);
  await page.getByLabel('配对码', { exact: true }).fill(pairing.code);
  await page.getByLabel('此设备名称', { exact: true }).fill('Native fleet test');
  await page.getByRole('button', { name: '发送配对请求', exact: true }).click();
  await expect(page.getByText('等待 Core 本机确认，请核对设备名称与指纹')).toBeVisible();
  const pending = await remoteAPI('/pairing/pending', undefined, owner.token);
  expect(pending).toHaveLength(1);
  await remoteAPI(
    '/pairing/approve',
    { id: pending[0].id, approve: true, role: 'operator' },
    owner.token,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 });
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.aggregate-host')).toHaveCount(2);
  await expect(page.locator('.aggregate-host[data-online=true]')).toHaveCount(2, {
    timeout: 20000,
  });
  await expect(page.locator('.aggregate-host-name', { hasText: '19528' })).toBeVisible();
  await expect(page.locator('.aggregate-host-name', { hasText: '19525' })).toBeVisible();
  await page.screenshot({
    path: path.join(root, 'artifacts/native-multi-core-overview.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '管理 Core 连接', exact: true }).click();
  await page
    .locator('.saved-core', { hasText: '19525' })
    .getByRole('button', { name: '切换', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.aggregate-host[data-online=true]')).toHaveCount(2);
  await page
    .evaluate(async () => {
      const internals = window.__TAURI_INTERNALS__;
      await internals.invoke('exit_desktop_app');
    })
    .catch((error) => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
  expect(errors).toEqual([]);
  console.log(
    'Native WebView2: mapped remote pairing verifies identity, submits and waits for independent owner approval; tests preserve local pairing, report refused port and wrong pin, and maintain two connected Cores with invalid inherited proxies',
  );
} finally {
  await browser?.close().catch(() => {});
  if (app?.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        app.kill();
        resolve();
      }, 10000);
      app.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  if (remote.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        remote.kill();
        resolve();
      }, 6000);
      remote.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      remote.stdin.end();
    });
  }
  for (const socket of sockets) socket.destroy();
  if (tunnel) await new Promise((resolve) => tunnel.close(resolve));
}
