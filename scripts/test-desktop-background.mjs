import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, '.tools/native-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/native-tests/background-'));
const executable =
  process.env.PANESTRA_TEST_EXE ||
  path.join(root, 'shell/desktop/target/release/panestra-desktop.exe');
const env = {
  ...process.env,
  PANESTRA_DATA_DIR: data,
  PANESTRA_CORE_LISTEN: '127.0.0.1:19447',
  WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19226',
};
const children = [];
let browser, page;
const errors = [];
function launch(args = []) {
  const child = spawn(executable, args, { cwd: path.dirname(executable), windowsHide: true, env });
  children.push(child);
  child.stderr.on('data', (data) => errors.push(data.toString()));
  return child;
}
async function until(check, description) {
  for (let i = 0; i < 60; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description}: ${errors.join('')}`);
}
function request(api, token = '') {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://127.0.0.1:19447/api/v1/${api}`,
      {
        rejectUnauthorized: false,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 3000,
      },
      (response) => {
        let body = '';
        response.on('data', (data) => {
          body += data;
        });
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(JSON.parse(body))
            : reject(new Error(`HTTP ${response.statusCode}`)),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('Core timeout')));
    req.on('error', reject);
  });
}
async function attach() {
  await browser?.close().catch(() => {});
  await until(async () => {
    browser = await chromium.connectOverCDP('http://127.0.0.1:19226');
    page = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes('tauri.localhost'));
    if (!page) {
      await browser.close();
      return false;
    }
    return true;
  }, 'Desktop window did not open');
}
async function invoke(command, args) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function disappear(action) {
  const closed = page.waitForEvent('close', { timeout: 15000 });
  await action().catch((error) => {
    if (!/closed|Target|destroyed/.test(String(error))) throw error;
  });
  await closed;
}

try {
  const primary = launch();
  await attach();
  await page.waitForFunction(
    () => document.querySelector('.fingerprint-input')?.value.length === 64,
  );
  await page.getByRole('button', { name: '建立并进入工作空间' }).click();
  await page.getByTestId('widget-cpu').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '查看System Monitor状态与设置' }).click();
  await page.getByLabel('读取系统指标').check();
  await page.getByRole('button', { name: '授权并启用' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const originalIdentity = await request('identity');
  // Obtain an independent authenticated session using the already paired test identity.
  const session = await page.evaluate(async (fingerprint) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const key = await invoke('plugin:panestra-bridge|identity');
    const post = async (path, value) => {
      const response = await invoke('plugin:panestra-bridge|request', {
        endpoint: 'https://127.0.0.1:19447',
        fingerprint,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (response.status !== 200) throw new Error(`Authentication ${response.status}`);
      return JSON.parse(response.body);
    };
    const challenge = await post('/api/v1/auth/challenge', {
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      purpose: 'login',
    });
    const signature = await invoke('plugin:panestra-bridge|sign', { message: challenge.message });
    const session = await post('/api/v1/auth/login', { challengeId: challenge.id, signature });
    return { token: session.token, deviceId: key.deviceId };
  }, originalIdentity.fingerprint);
  let healthBefore;
  await until(async () => {
    healthBefore = await request('health', session.token);
    return (
      healthBefore.plugins.length === 7 && healthBefore.plugins.every((plugin) => plugin.pid > 0)
    );
  }, 'Authorized plugin did not start');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('启动时进入后台')).not.toBeChecked();
  await expect(page.getByLabel('关闭窗口时转入后台')).not.toBeChecked();
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-background-settings.png'),
    fullPage: true,
  });
  const panel = page.locator('.desktop-service');
  const geometry = await panel.evaluate((element) => {
    const heading = element.querySelector('.panel-title').getBoundingClientRect();
    const option = element.querySelector('.desktop-service-option').getBoundingClientRect();
    const button = element.querySelector('button').getBoundingClientRect();
    return { inset: option.x - heading.x, buttonHeight: button.height };
  });
  expect(geometry.inset).toBeGreaterThanOrEqual(24);
  expect(geometry.buttonHeight).toBe(44);
  await panel.screenshot({ path: path.join(root, 'artifacts/desktop-service-day.png') });
  await page.getByRole('button', { name: '切换黑夜', exact: true }).click();
  await panel.screenshot({ path: path.join(root, 'artifacts/desktop-service-night.png') });
  await disappear(() => page.getByRole('button', { name: '切换为后台模式', exact: true }).click());
  expect(primary.exitCode).toBeNull();
  expect(await request('identity')).toEqual(originalIdentity);
  const healthAfter = await request('health', session.token);
  expect(healthAfter).toBeTruthy();
  expect(healthBefore).toBeTruthy();
  expect(healthAfter.uptime).toBeGreaterThan(healthBefore.uptime);
  expect(healthAfter.plugins.map((plugin) => [plugin.id, plugin.pid])).toEqual(
    healthBefore.plugins.map((plugin) => [plugin.id, plugin.pid]),
  );
  expect(healthAfter.plugins.every((plugin) => plugin.pid > 0)).toBe(true);
  await until(
    async () => (await request('health', session.token)).websocket.connections === 0,
    'Released desktop retained a WebSocket',
  );
  expect((await request('me', session.token)).id).toBe(session.deviceId);
  const silentDuplicate = launch(['--background']);
  await until(
    async () => silentDuplicate.exitCode !== null,
    'Duplicate background launch did not exit',
  );
  expect(silentDuplicate.exitCode).toBe(0);
  expect(await request('identity')).toEqual(originalIdentity);
  const duplicate = launch();
  await attach();
  await until(async () => duplicate.exitCode !== null, 'Second instance did not exit');
  expect(duplicate.exitCode).toBe(0);
  await page.getByTestId('widget-cpu').waitFor();
  expect((await invoke('plugin:panestra-bridge|identity')).deviceId).toBe(session.deviceId);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('关闭窗口时转入后台').check();
  await expect(page.getByLabel('关闭窗口时转入后台')).toBeEnabled();
  await page.getByLabel('启动时进入后台').check();
  await expect(page.getByLabel('启动时进入后台')).toBeEnabled();
  await disappear(() => invoke('plugin:window|close', { label: 'main' }));
  expect(await request('identity')).toEqual(originalIdentity);
  launch();
  await attach();
  await page.getByTestId('widget-cpu').waitFor();
  await disappear(() => invoke('exit_desktop_app'));
  await until(async () => primary.exitCode !== null, 'Explicit exit did not stop application');
  await until(async () => {
    try {
      await request('identity');
      return false;
    } catch {
      return true;
    }
  }, 'Explicit exit did not stop Core');
  await browser?.close().catch(() => {});
  const startup = launch();
  await until(
    async () => (await request('identity')).serverId === originalIdentity.serverId,
    'Background startup did not start Core',
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let hasWindow = false;
  try {
    const debug = await chromium.connectOverCDP('http://127.0.0.1:19226', { timeout: 2000 });
    hasWindow = debug
      .contexts()
      .some((context) => context.pages().some((page) => page.url().includes('tauri.localhost')));
    await debug.close();
  } catch {}
  expect(hasWindow).toBe(false);
  expect(startup.exitCode).toBeNull();
  launch();
  await attach();
  await page.getByTestId('widget-cpu').waitFor();
  expect((await invoke('plugin:panestra-bridge|identity')).deviceId).toBe(session.deviceId);
  const preferences = await invoke('desktop_mode_info');
  expect(preferences).toEqual({ startInBackground: true, closeToBackground: true });
  await invoke('configure_desktop_mode', {
    preferences: { startInBackground: false, closeToBackground: false },
  });
  await disappear(() => invoke('plugin:window|close', { label: 'main' }));
  await until(
    async () => startup.exitCode !== null,
    'Default close behavior did not stop application',
  );
  writeFileSync(
    path.join(root, 'artifacts/desktop-background-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        windowDestroyed: true,
        serviceAvailableWhileBackground: true,
        duplicateLaunchRestoresExistingInstance: true,
        backgroundStartup: true,
        preferencesPersist: true,
        pairingPreserved: true,
        explicitExitStopsCore: true,
        defaultCloseStopsCore: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Windows background lifecycle passed: window release, authenticated Core requests, singleton recovery, preferences, pairing and graceful exit',
  );
} finally {
  await browser?.close().catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill();
}
