import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import path from 'node:path';

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
  await page.getByRole('button', { name: '建立主机', exact: true }).click();
  await page.getByLabel('Core 地址', { exact: true }).fill('https://127.0.0.1:19528');
  await page.getByLabel('Core 身份指纹').fill(target.fingerprint);
  await page.getByLabel('首次认领码', { exact: true }).fill(target.bootstrap);
  await page.getByLabel('此设备名称', { exact: true }).fill('Native fleet test');
  await page.getByRole('button', { name: '建立并进入工作空间', exact: true }).click();
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
    'Native WebView2: distinct local and mapped remote Cores stay online, switches preserve aggregation, pinned TLS bypasses inherited proxy settings',
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
