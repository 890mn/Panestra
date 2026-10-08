// Isolated Windows acceptance: never use the installed Core or its WebView data.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
mkdirSync(path.join(root, '.tools/native-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/native-tests/uranus23-'));
const child = spawn(path.join(root, 'shell/desktop/target/release/panestra-desktop.exe'), [], {
  windowsHide: true,
  env: {
    ...process.env,
    PANESTRA_DATA_DIR: data,
    PANESTRA_CORE_LISTEN: '127.0.0.1:19447',
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19228',
  },
});
let browser;
const errors = [];
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:19228');
      break;
    } catch {
      if (child.exitCode !== null) throw new Error('Isolated application exited before startup');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) throw new Error('Isolated WebView2 debugger unavailable');
  const context = browser.contexts()[0];
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = context.pages().find((page) => page.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error('Panestra native page missing');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(
    () => document.querySelector('.fingerprint-input')?.value.length === 64,
  );
  await page.getByRole('button', { name: '建立并进入工作空间', exact: true }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于 Panestra', exact: true }).click();
  const versionButton = page.getByRole('button', { name: `版本 v${version}`, exact: true });
  for (let tap = 0; tap < 7; tap++) await versionButton.click();
  await expect(page.getByRole('dialog', { name: '天王星 23°' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '永夜', exact: true }).click();
  await page.getByRole('button', { name: '开启天王星 23°', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'uranus23');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  for (const [label, theme] of [
    ['day', '冰昼'],
    ['night', '永夜'],
  ]) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.getByRole('button', { name: '主机工作区', exact: true }).click();
    await expect(page.getByTestId('widget-cpu')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await expect(page.locator('.uranus-horizon')).toContainText(theme);
    await page.screenshot({ path: path.join(root, `artifacts/uranus23-native-${label}.png`) });
    // Confirm local images are decoded under the native CSP, rather than just trusting CSS URLs.
    await page.evaluate(async () => {
      const url = getComputedStyle(document.documentElement)
        .getPropertyValue('--uranus-sky')
        .match(/url\(["']?([^"')]+)/)?.[1];
      if (!url) throw new Error('Sky asset missing');
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth) throw new Error('Sky asset failed to decode');
    });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'uranus23');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect(page.locator('.topbar')).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '退出彩蛋模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'standard');
  expect(errors).toEqual([]);
  writeFileSync(
    path.join(root, 'artifacts/uranus23-native-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        version,
        surface: 'Windows Tauri / WebView2',
        isolated: true,
        discovery: true,
        bothSkiesDecoded: true,
        restartPersistence: true,
        restoredStandardAppearance: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Windows ${version}: Uranus 23° discovery, both skies, persistence and exit passed`);
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('exit_desktop_app'))
    .catch((error) => {
      if (!/closed|disposed/.test(error.message)) throw error;
    });
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 6000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
