// The human points the authorized USB tablet at the displayed test QR.
// Does not clear app data, submit pairing, revoke devices or change the saved endpoint.
import { chromium, expect } from '@playwright/test';
import QRCode from 'qrcode';
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
  await page.getByRole('button', { name: '连接其他 Core', exact: true }).click();
  const originalURI = await page.getByLabel('Core 地址', { exact: true }).inputValue();
  const fingerprint = await page.getByLabel('Core 身份指纹').inputValue();
  const code = 'CAMERATEST123';
  const payload = {
    schemaVersion: 1,
    endpoint: originalURI,
    serverId,
    fingerprint,
    code,
    expiresAt: new Date(Date.now() + 240000).toISOString(),
  };
  await QRCode.toFile(
    path.join(root, 'artifacts/physical-scan-code.png'),
    JSON.stringify(payload),
    { width: 520, margin: 4 },
  );
  await page.getByRole('button', { name: '扫描电脑配对二维码', exact: true }).click();
  console.log(
    'QR_READY: point the USB tablet camera at artifacts/physical-scan-code.png; allow the camera permission prompt. No pairing will be submitted.',
  );
  await expect(page.getByLabel('配对码', { exact: true })).toHaveValue(code, { timeout: 180000 });
  await expect(page.getByLabel('Core 地址', { exact: true })).toHaveValue(originalURI);
  await expect(page.getByLabel('Core 身份指纹')).toHaveValue(fingerprint);
  await expect(page.getByRole('button', { name: '发送配对请求', exact: true })).toBeEnabled();
  await page.screenshot({
    path: path.join(root, 'artifacts/physical-scan-filled.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.live-pill')).toContainText('实时同步');
  writeFileSync(
    path.join(root, 'artifacts/physical-scan-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        device: 'USB M367FC',
        androidAPI: run('shell', 'getprop', 'ro.build.version.sdk').trim(),
        actualCameraDecoded: true,
        addressAndFingerprintAndCodeFilled: true,
        priorConnectionPreserved: true,
        pairingSubmitted: false,
      },
      null,
      2,
    ),
  );
  console.log('Physical camera scan passed; original paired Core remains connected.');
} finally {
  await browser?.close().catch(() => {});
  run('forward', '--remove', 'tcp:19227');
}
