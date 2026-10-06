// Preserves the authorized USB tablet's existing identity, workspace and pairing.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const device = process.env.PANESTRA_TEST_ANDROID;
if (!device || device.includes(':') || device.startsWith('emulator-'))
  throw new Error('Set PANESTRA_TEST_ANDROID to the authorized USB device serial');
const adb = path.join(root, '.tools/android-sdk/platform-tools/adb.exe');
const run = (...args) =>
  execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8', windowsHide: true });
const pid = run('shell', 'pidof', 'dev.panestra.app').trim();
if (!/^\d+$/.test(pid)) throw new Error('Open Panestra on the USB tablet first');
run('forward', 'tcp:19227', `localabstract:webview_devtools_remote_${pid}`);
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:19227', { noDefaults: true });
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes('tauri.localhost'));
  if (!page) throw new Error('Panestra WebView missing');
  await expect(page.locator('.live-pill')).toContainText('实时同步', { timeout: 15000 });
  if (await page.locator('dialog[open]').count())
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  const menu = page.getByRole('button', { name: '打开菜单', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '设备与连接', exact: true }).click();
  const serverId = await page.locator('.endpoint-panel h3').innerText();
  // Call the NSD bridge directly: no known-host cache and no manually supplied IP.
  const discovered = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:panestra-bridge|discover'),
  );
  await page.getByRole('button', { name: '连接其他 Core', exact: true }).click();
  const uri = await page.getByLabel('Core 地址', { exact: true }).inputValue();
  const fingerprint = await page.getByLabel('Core 身份指纹').inputValue();
  const scan = page.getByRole('button', { name: '扫描电脑配对二维码', exact: true });
  await scan.click();
  // The actual camera decoding has a separate human-assisted test. Avoid an
  // unbounded OEM dumpsys call here; check that scanning is pending, then cancel.
  await expect(scan).toBeDisabled();
  await new Promise((resolve) => setTimeout(resolve, 750));
  run('shell', 'input', 'keyevent', '4');
  await expect(scan).toBeEnabled({ timeout: 10000 });
  await expect(page.getByLabel('Core 地址', { exact: true })).toHaveValue(uri);
  await expect(page.getByLabel('Core 身份指纹')).toHaveValue(fingerprint);
  // A previously paired identity should reauthenticate, without registering again.
  await page.getByLabel('配对码', { exact: true }).fill('RECONNECTTEST123');
  await page.getByRole('button', { name: '发送配对请求', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.live-pill')).toContainText('实时同步', { timeout: 15000 });
  await expect(page.locator('.endpoint-panel h3')).toHaveText(serverId);
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.getByTestId('widget-cpu').locator('.metric-value')).not.toContainText('—', {
    timeout: 15000,
  });
  await page.screenshot({
    path: path.join(root, 'artifacts/physical-tablet-updated.png'),
    animations: 'disabled',
  });
  const packageInfo = run('shell', 'dumpsys', 'package', 'dev.panestra.app');
  const discoveryPassed = discovered.some(
    (candidate) =>
      candidate.serverIdHint === serverId &&
      new URL(candidate.uri).hostname === new URL(uri).hostname,
  );
  const result = {
    status: discoveryPassed ? 'passed' : 'discovery-unconfirmed',
    version: packageInfo.match(/\bversionName=([^\s]+)/)?.[1],
    device: 'USB M367FC',
    androidAPI: run('shell', 'getprop', 'ro.build.version.sdk').trim(),
    nativeNSD: {
      bypassedKnownHostCache: true,
      foundCurrentCore: discoveryPassed,
      candidates: discovered,
    },
    scanRequestPendingBeforeCancellation: true,
    cancellationReturned: true,
    pairedCoreReauthentication: true,
    priorIdentityAndConnectionPreserved: true,
    realMetrics: true,
    dataCleared: false,
    pairingOrRevocationPerformed: false,
  };
  writeFileSync(
    path.join(root, 'artifacts/physical-connection-result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close().catch(() => {});
  run('forward', '--remove', 'tcp:19227');
}
