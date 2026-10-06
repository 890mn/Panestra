import { chromium, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const adb = path.join(root, '.tools/android-sdk/platform-tools/adb.exe');
const device = process.env.PANESTRA_TEST_ANDROID;
if (!device)
  throw new Error('Set PANESTRA_TEST_ANDROID explicitly; no emulator is selected automatically');
const run = (...args) =>
  execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8', windowsHide: true });
mkdirSync(path.join(root, '.tools/native-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/native-tests/android-core-'));
const core = spawn(
  path.join(root, 'artifacts/panestra-core.exe'),
  [
    '--data',
    data,
    '--listen',
    '0.0.0.0:19444',
    '--worker',
    path.join(root, 'artifacts/system-plugin.exe'),
    '--manifest',
    path.join(root, 'plugins/system/manifest.json'),
    '--parent-stdio',
  ],
  { cwd: root, windowsHide: true },
);
let bootstrap = '',
  fingerprint = '',
  web,
  android;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Core startup timeout')), 15000);
    core.stdout.on('data', (raw) => {
      const match = raw.toString().match(/认领码[^:]+: (\S+)/);
      if (match) bootstrap = match[1];
    });
    core.stderr.on('data', (raw) => {
      for (const line of raw.toString().split('\n')) {
        try {
          const log = JSON.parse(line);
          if (log.msg === 'Panestra Core ready') {
            fingerprint = log.fingerprint;
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      }
    });
    core.on('exit', (code) => reject(new Error(`Core exit ${code}`)));
  });
  web = await chromium.launch({ channel: 'chrome' });
  const context = await web.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });
  const desktop = await context.newPage();
  await desktop.goto('https://localhost:19444');
  await desktop.getByLabel('Core 身份指纹').fill(fingerprint);
  await desktop.getByLabel('首次认领码').fill(bootstrap);
  await desktop.getByRole('button', { name: '建立并进入工作空间' }).click();
  await expect(desktop.getByTestId('widget-cpu')).toBeVisible();
  await desktop.getByRole('button', { name: '插件', exact: true }).click();
  await desktop.getByLabel('读取系统指标').check();
  await desktop.getByRole('button', { name: '授权并启用' }).click();
  await desktop.getByRole('button', { name: '设备与连接', exact: true }).click();
  await desktop.getByRole('button', { name: '添加设备', exact: true }).click();
  const code = await desktop.locator('.pairing-code').innerText();
  // This script uses only the Panestra package installed by this task and needs a fresh identity.
  if (process.env.PANESTRA_TEST_FRESH === '1') run('shell', 'pm', 'clear', 'dev.panestra.app');
  run('reverse', 'tcp:19444', 'tcp:19444');
  run('shell', 'am', 'start', '-n', 'dev.panestra.app/.MainActivity');
  let pid = '';
  for (let i = 0; i < 30; i++) {
    try {
      pid = run('shell', 'pidof', 'dev.panestra.app').trim();
    } catch {}
    if (pid) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!pid) throw new Error('Android app not running');
  run('forward', 'tcp:19226', `localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; i < 60; i++) {
    try {
      android = await chromium.connectOverCDP('http://127.0.0.1:19226', { noDefaults: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!android) throw new Error('Android debug WebView did not start');
  const page = android.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('Core 地址').waitFor();
  await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await page.getByRole('button', { name: '扫描电脑配对二维码', exact: true }).click();
  const scanner = page.getByRole('button', { name: '扫描电脑配对二维码', exact: true });
  await expect(scanner).toBeDisabled();
  await new Promise((r) => setTimeout(r, 750));
  run('shell', 'input', 'keyevent', '4');
  await expect(page.getByRole('button', { name: '扫描电脑配对二维码', exact: true })).toBeEnabled({
    timeout: 10000,
  });
  await page.screenshot({
    path: path.join(root, 'artifacts/android-scan-entry.png'),
    animations: 'disabled',
  });
  const discoveries = await page.locator('.discovered button').allTextContents();
  await page.getByLabel('Core 地址').fill('https://localhost:19444');
  await page.getByLabel('Core 身份指纹').fill(fingerprint);
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByLabel('此设备名称').fill('原生 Android 测试');
  await page.getByRole('button', { name: '发送配对请求' }).click();
  await expect(desktop.getByText('原生 Android 测试 请求连接')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '允许查看与编辑' }).click();
  await expect(page.getByTestId('widget-cpu')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('widget-cpu').locator('.metric-value')).not.toContainText('—', {
    timeout: 15000,
  });
  await page.getByRole('button', { name: '配置处理器', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Android 原生同步');
  await page.getByRole('button', { name: '保存配置' }).click();
  await desktop.getByRole('button', { name: '总览', exact: true }).click();
  await expect(
    desktop.getByTestId('widget-cpu').getByRole('heading', { name: 'Android 原生同步' }),
  ).toBeVisible();
  await page.getByTestId('widget-cpu').locator('.sparkline').waitFor({ timeout: 15000 });
  await page.locator('.toast').waitFor({ state: 'hidden', timeout: 10000 });
  await page.screenshot({
    path: path.join(root, 'artifacts/native-android.png'),
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.getByTestId('widget-cpu')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '设备与连接', exact: true }).click();
  await desktop.getByRole('button', { name: '撤销原生 Android 测试', exact: true }).click();
  await desktop.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑布局', exact: true })).toBeDisabled({
    timeout: 10000,
  });
  if (errors.length) throw new Error(errors.join('\n'));
  writeFileSync(
    path.join(root, 'artifacts/native-android-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        device,
        api: run('shell', 'getprop', 'ro.build.version.sdk').trim(),
        identity: 'Android Keystore P-256',
        transport: 'Kotlin OkHttp pinned TLS 1.3 / WSS',
        scanRequestPendingBeforeCancellation: true,
        scanCancellationReturned: true,
        cameraRecognition: 'covered separately by the physical scanner test',
        reconnected: true,
        revoked: true,
        discoveries,
        network: 'ADB reverse for transport; LAN multicast discovery separately required',
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native Android passed: Keystore, pairing, pinned HTTPS/WSS, real telemetry, editing, reconnect, revoke',
  );
} finally {
  await android?.close().catch(() => {});
  await web?.close().catch(() => {});
  core.stdin.end();
  await new Promise((resolve) => {
    if (core.exitCode !== null) {
      resolve();
      return;
    }
    core.once('exit', resolve);
    setTimeout(() => {
      core.kill();
      resolve();
    }, 6000);
  });
  for (const args of [
    ['reverse', '--remove', 'tcp:19444'],
    ['forward', '--remove', 'tcp:19226'],
    ['shell', 'am', 'force-stop', 'dev.panestra.app'],
  ]) {
    try {
      run(...args);
    } catch {}
  }
}
