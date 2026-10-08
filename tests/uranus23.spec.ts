import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { version } from '../package.json';

let vite: ViteDevServer;
let child: ChildProcess;
let identity: { uri: string; fingerprint: string; bootstrap: string };
const origin = 'http://127.0.0.1:19526';

test.beforeAll(async () => {
  mkdirSync('.tools/uranus-tests', { recursive: true });
  child = spawn(
    path.resolve('artifacts/panestra-core.exe'),
    [
      '--data',
      mkdtempSync(path.resolve('.tools/uranus-tests/core-')),
      '--listen',
      '127.0.0.1:19525',
      '--origins',
      origin,
      '--plugin-seed',
      path.resolve('artifacts/plugin-seed'),
      '--parent-stdio',
    ],
    { windowsHide: true },
  );
  identity = await new Promise((resolve, reject) => {
    let bootstrap = '',
      fingerprint = '',
      stderr = '',
      stdout = '';
    const timer = setTimeout(() => reject(new Error('Isolated Core startup timeout')), 15000);
    const ready = () => {
      if (bootstrap && fingerprint) {
        clearTimeout(timer);
        resolve({ uri: 'https://127.0.0.1:19525', bootstrap, fingerprint });
      }
    };
    child.stdout!.on('data', (data) => {
      stdout += data.toString();
      bootstrap = stdout.match(/认领码[^:]+: (\S+)/)?.[1] || '';
      ready();
    });
    child.stderr!.on('data', (data) => {
      stderr += data.toString();
      for (const line of stderr.split('\n')) {
        try {
          const log = JSON.parse(line);
          if (log.msg === 'Panestra Core ready') fingerprint = log.fingerprint;
        } catch {
          /* Wait for complete log lines. */
        }
      }
      ready();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Isolated Core exited before startup'));
    });
  });
  vite = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    root: path.resolve('tests/connection-preview'),
    publicDir: path.resolve('client/public'),
    server: { host: '127.0.0.1', port: 19526, strictPort: true, fs: { allow: [process.cwd()] } },
    logLevel: 'error',
  });
  await vite.listen();
});
test.afterAll(async () => {
  await vite?.close();
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 6000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin!.end();
    });
  }
});

test('彩蛋发现、独有昼夜、系统切换、恢复退出与三种屏幕', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: '关于 Panestra' })).toBeVisible();
  expect(requests.filter((url) => /uranus23\/.*webp/.test(url))).toHaveLength(0);
  await page.evaluate(async (identity) => {
    await (window as any).connectionCore.claim(
      identity.uri,
      identity.fingerprint,
      identity.bootstrap,
      'Uranus test',
      true,
    );
  }, identity);
  await expect(page.locator('.topbar')).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.uranus-settings')).toHaveCount(0);
  await page.getByRole('button', { name: '点缀色 #6a8eaf', exact: true }).click();
  await page.getByRole('button', { name: '关于 Panestra' }).click();
  const versionButton = page.getByRole('button', { name: `版本 v${version}`, exact: true });
  await versionButton.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Space');
  await expect(page.locator('.uranus-portal')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: '天王星 23°' })).toBeVisible();
  await page.getByRole('button', { name: '永夜', exact: true }).click();
  await expect(page.locator('.uranus-landscape.night')).toBeVisible();
  await page.getByRole('button', { name: '开启天王星 23°', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'uranus23');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect(page.locator('.uranus-horizon')).toBeVisible();
  await expect(page.getByRole('button', { name: '冰昼', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '永夜', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  // A manual toggle follows the resolved system colour, rather than the stored 'system' token.
  await page.getByRole('button', { name: '切换白昼', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'uranus23');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await expect(page.locator('.topbar')).toBeVisible();

  for (const [name, width, height] of [
    ['desktop', 1440, 960],
    ['tablet', 900, 1200],
    ['phone', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const menu = page.getByRole('button', { name: '打开菜单', exact: true });
    if (width < 768 && (await menu.isVisible())) await menu.click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    for (const scene of ['冰昼', '永夜']) {
      await page.getByRole('button', { name: scene, exact: true }).click();
      await expect(page.locator('.uranus-horizon')).toBeVisible();
      const measures = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        motion: getComputedStyle(document.querySelector('.uranus-horizon')!).animationName,
        buttons: Array.from(
          document.querySelectorAll('.uranus-settings button, .uranus-view-button'),
        ).map((button) => button.getBoundingClientRect().height),
        accent: document.documentElement.style.getPropertyValue('--accent'),
      }));
      expect(measures.overflow).toBe(false);
      expect(measures.motion).toBe('none');
      expect(measures.buttons.every((height) => height === 44)).toBe(true);
      expect(measures.accent).toBe('#6a8eaf');
      await page.screenshot({
        path: `artifacts/uranus23-${name}-${scene === '冰昼' ? 'day' : 'night'}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: '观景', exact: true }).click();
    await expect(page.locator('.uranus-landscape.night')).toBeVisible();
    await page
      .getByRole('dialog', { name: '天王星 23°' })
      .getByRole('button', { name: '冰昼', exact: true })
      .click();
    await expect(page.locator('.uranus-landscape.day')).toBeVisible();
    await page.screenshot({ path: `artifacts/uranus23-${name}-observatory.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('button', { name: '观景', exact: true })).toBeFocused();
  }
  await page.getByRole('button', { name: '退出彩蛋模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'standard');
  await expect(page.locator('.uranus-horizon')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '白昼', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '黑夜', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '点缀色 #6a8eaf', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'standard');
  expect(errors).toEqual([]);
});

test('旧主题迁移与损坏偏好可恢复，未开启时不请求壁纸', async ({ page }) => {
  const errors: string[] = [];
  const skies: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/uranus23\/.*webp/.test(request.url())) skies.push(request.url());
  });
  await page.goto(origin);
  for (const saved of [
    '{"mode":"night","accent":"#9c88ba"}',
    'null',
    '{invalid',
    '{"mode":"wrong","accent":"bad"}',
  ]) {
    await page.evaluate((saved) => localStorage.setItem('panestra.theme.v1', saved), saved);
    await page.reload();
    await expect(page.getByRole('button', { name: '关于 Panestra' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      saved.includes('night') ? 'night' : 'day',
    );
    await expect(page.locator('html')).toHaveAttribute('data-experience', 'standard');
    if (saved.includes('#9c88ba'))
      expect(
        await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')),
      ).toBe('#9c88ba');
  }
  expect(errors).toEqual([]);
  expect(skies).toEqual([]);
});
