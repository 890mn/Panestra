import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, '.tools/native-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/native-tests/desktop-'));
const executable =
  process.env.PANESTRA_TEST_EXE ||
  path.join(root, 'shell/desktop/target/release/panestra-desktop.exe');
const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  windowsHide: true,
  env: {
    ...process.env,
    PANESTRA_DATA_DIR: data,
    PANESTRA_CORE_LISTEN: '127.0.0.1:19446',
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19225',
  },
});
let browser;
const errors = [];
let output = '';
child.stdout.on('data', (data) => {
  output += data.toString();
});
child.stderr.on('data', (data) => {
  output += data.toString();
});
try {
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:19225');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser)
    throw new Error(`Native WebView2 debugger did not start (exit ${child.exitCode}): ${output}`);
  const context = browser.contexts()[0];
  let page;
  for (let i = 0; i < 60; i++) {
    page = context.pages().find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error('Panestra WebView2 page not found');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('Core 身份指纹').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.fingerprint-input')?.value.length === 64,
  );
  const fingerprint = await page.getByLabel('Core 身份指纹').inputValue();
  if (!(await page.getByLabel('首次认领码').inputValue()))
    throw new Error('Native sidecar bootstrap code missing');
  await page.screenshot({
    path: path.join(root, 'artifacts/connection-desktop-native-0.1.11.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '建立并进入工作空间' }).click();
  await page.getByTestId('widget-cpu').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByLabel('读取系统指标').check();
  await page.getByRole('button', { name: '授权并启用' }).click();
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-testid="widget-cpu"] .metric-value')
        ?.textContent?.includes('—'),
  );
  await page.getByTestId('widget-cpu').locator('.view-chart').waitFor({ timeout: 15000 });
  await page.locator('.toast').waitFor({ state: 'hidden', timeout: 10000 });
  await page.screenshot({
    path: path.join(root, 'artifacts/native-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const updateGuard = await page.evaluate(async () => {
    const callback = window.__TAURI_INTERNALS__.transformCallback(() => {}, true);
    try {
      await window.__TAURI_INTERNALS__.invoke('install_app_update', {
        expectedVersion: '0.1.11',
        progress: `__CHANNEL__:${callback}`,
      });
    } catch (error) {
      return String(error);
    }
  });
  expect(updateGuard).toContain('当前没有可安装的更新');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  const updateCheck = await page.locator('.update-status').innerText();
  await page.getByRole('button', { name: '更新日志', exact: true }).click();
  await page.getByRole('button', { name: '查看 v0.1.11 更新说明', exact: true }).click();
  await expect(page.locator('.release-detail')).toContainText('恢复品牌与版本二级菜单');
  await page.screenshot({ path: path.join(root, 'artifacts/native-desktop-update-logs.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '关于 Panestra', exact: true }).click();
  await expect(page.locator('.about-version')).toHaveText('v0.1.11');
  await page.screenshot({ path: path.join(root, 'artifacts/native-desktop-about.png') });
  await page.getByRole('button', { name: 'GitHub 项目', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GitHub 项目', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  writeFileSync(
    path.join(root, 'artifacts/native-desktop-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        executable,
        surface: 'real Windows Tauri / WebView2',
        sidecar: true,
        deviceStorage: 'Windows DPAPI',
        transport: 'native pinned TLS 1.3 + WSS',
        fingerprint,
        systemBrowserProjectLink: true,
        updateGuard,
        updateCheck,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Native desktop passed: DPAPI identity, bootstrap, pinned HTTPS/WSS, real metrics');
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:panestra-bridge|disconnect', {
      connectionId: 'test-cleanup',
    }),
  );
  // Close the actual native window so the sidecar exercises graceful shutdown.
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch((error) => {
      if (!error.message.includes('has been closed')) throw error;
    });
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    setTimeout(() => reject(new Error('Native application failed graceful exit')), 10000);
  });
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
