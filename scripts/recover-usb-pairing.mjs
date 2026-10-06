// Explicit repair of an existing, revoked USB device through normal owner UI.
// Does not clear application data, change keys or edit the Core database.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const serial = process.env.PANESTRA_TEST_ANDROID;
if (
  process.env.PANESTRA_REPAIR_EXISTING_PAIRING !== '1' ||
  !serial ||
  serial.includes(':') ||
  serial.startsWith('emulator-')
)
  throw new Error('Explicit existing-pairing repair and an authorized USB serial are required');
const expectedServer = process.env.PANESTRA_EXPECTED_SERVER;
if (!expectedServer) throw new Error('The previously verified Core server ID is required');
const adb = path.join(root, '.tools/android-sdk/platform-tools/adb.exe');
const run = (...args) =>
  execFileSync(adb, ['-s', serial, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
const pid = run('shell', 'pidof', 'dev.panestra.app').trim();
if (!/^\d+$/.test(pid)) throw new Error('Open Panestra on the USB tablet first');
run('forward', 'tcp:19227', `localabstract:webview_devtools_remote_${pid}`);
let ownerBrowser, tabletBrowser;
try {
  ownerBrowser = await chromium.connectOverCDP('http://127.0.0.1:19228', { noDefaults: true });
  tabletBrowser = await chromium.connectOverCDP('http://127.0.0.1:19227', { noDefaults: true });
  const owner = ownerBrowser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes('tauri.localhost'));
  const tablet = tabletBrowser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes('tauri.localhost'));
  if (!owner || !tablet) throw new Error('Both native Panestra surfaces must be available');
  await expect(owner.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  await owner.getByRole('button', { name: '设备与连接', exact: true }).click();
  await expect(owner.locator('.endpoint-panel h3')).toHaveText(expectedServer);
  await expect(tablet.locator('.offline-banner')).toContainText('授权已被撤销', { timeout: 15000 });
  const before = await tablet.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:panestra-bridge|identity'),
  );
  if (await tablet.locator('dialog[open]').count())
    await tablet.getByRole('button', { name: '关闭', exact: true }).click();
  await tablet.getByRole('button', { name: '重新配对', exact: true }).click();
  const originalAddress = await tablet.getByLabel('Core 地址', { exact: true }).inputValue();
  const fingerprint = await tablet.getByLabel('Core 身份指纹').inputValue();
  // Native desktop core metadata must agree with the tablet's existing pin.
  const info = await owner.evaluate(() => window.__TAURI_INTERNALS__.invoke('local_core_info'));
  if (info.fingerprint !== fingerprint)
    throw new Error('Saved tablet pin differs from the local Core; refusing repair');
  await owner.getByLabel('此次允许远程配对', { exact: false }).check();
  await owner.getByRole('button', { name: '添加设备', exact: true }).click();
  const code = await owner.locator('.pairing-code').innerText();
  await tablet.getByRole('button', { name: '配对此设备', exact: true }).click();
  await tablet.getByLabel('配对码', { exact: true }).fill(code);
  await tablet.getByLabel('此设备名称').fill('USB 平板');
  await tablet.getByRole('button', { name: '发送配对请求', exact: true }).click();
  await expect(owner.getByText('USB 平板 请求连接', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(tablet.getByText('等待 Core 本机确认', { exact: false })).toBeVisible();
  await expect(tablet.locator('.live-pill')).toContainText('离线');
  await owner.getByRole('button', { name: '允许查看与编辑', exact: true }).click();
  await expect(tablet.locator('dialog[open]')).toHaveCount(0, { timeout: 15000 });
  await expect(tablet.locator('.live-pill')).toContainText('实时同步', { timeout: 15000 });
  const after = await tablet.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:panestra-bridge|identity'),
  );
  if (before.deviceId !== after.deviceId || before.publicKey !== after.publicKey)
    throw new Error('Device identity changed during repair');
  const menu = tablet.getByRole('button', { name: '打开菜单', exact: true });
  if (await menu.isVisible()) await menu.click();
  await tablet.getByRole('button', { name: '总览', exact: true }).click();
  await expect(tablet.getByRole('button', { name: '编辑布局', exact: true })).toBeEnabled();
  await expect(tablet.getByTestId('widget-cpu').locator('.metric-value')).not.toContainText('—', {
    timeout: 15000,
  });
  await tablet.screenshot({
    path: path.join(root, 'artifacts/physical-repair-tablet.png'),
    animations: 'disabled',
  });
  writeFileSync(
    path.join(root, 'artifacts/physical-repair-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        version: '0.1.2',
        device: 'USB M367FC',
        deviceId: before.deviceId,
        serverId: expectedServer,
        endpoint: originalAddress,
        previousPinPreserved: true,
        sameKeystoreIdentity: true,
        remainedOfflineUntilApproval: true,
        ownerUIExplicitReapproval: true,
        role: 'operator',
        liveMetrics: true,
        editingRestored: true,
        dataCleared: false,
        databaseEdited: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'USB tablet connection restored through owner UI reapproval; original identity and workspace preserved.',
  );
} finally {
  await ownerBrowser?.close().catch(() => {});
  await tabletBrowser?.close().catch(() => {});
  run('forward', '--remove', 'tcp:19227');
}
