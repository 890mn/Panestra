import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { version } from '../package.json';

const API = 'https://api.github.com/repos/890mn/Panestra/releases/latest';
let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    root: path.resolve('tests/update-preview'),
    publicDir: path.resolve('client/public'),
    server: { host: '127.0.0.1', port: 19520, strictPort: true, fs: { allow: [process.cwd()] } },
    logLevel: 'error',
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});
const release = (tag = '0.1.12') => ({
  tag_name: `v${tag}`,
  body: '<script>unsafe()</script>\n- 新功能',
  draft: false,
  prerelease: false,
  published_at: '2026-10-06T00:00:00Z',
  assets: [
    {
      name: 'latest.json',
      browser_download_url: `https://github.com/890mn/Panestra/releases/download/v${tag}/latest.json`,
    },
    {
      name: `Panestra-${tag}-android-arm64.apk`,
      browser_download_url: `https://github.com/890mn/Panestra/releases/download/v${tag}/Panestra-${tag}-android-arm64.apk`,
      digest: 'sha256:' + 'a'.repeat(64),
    },
  ],
});

test('版本检查区分空发布、当前版本、旧版本、错误与离线，日志可返回', async ({ page }) => {
  await page.goto('http://127.0.0.1:19520');
  await expect(page.getByText(`v${version}`, { exact: true }).first()).toBeVisible();
  const fixture = async (status: number, body: unknown) => {
    await page.unroute(API);
    await page.route(API, (route) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
    );
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
  };
  await fixture(404, {});
  await expect(page.getByRole('status')).toHaveText('暂无发布版本');
  await fixture(200, release(version));
  await expect(page.getByRole('status')).toHaveText('已是最新版本');
  await fixture(200, release('0.1.9'));
  await expect(page.getByRole('status')).toHaveText('已是最新版本');
  await fixture(403, {});
  await expect(page.getByRole('status')).toContainText('请求暂时受限');
  await fixture(200, { ...release(), tag_name: 'unexpected-version' });
  await expect(page.getByRole('status')).toContainText('发布版本格式不正确');
  await page.unroute(API);
  await page.route(API, (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.locator('.update-status')).toHaveAttribute('data-error', 'true');
  await fixture(200, release());
  await expect(page.getByRole('button', { name: '下载并更新', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '更新日志', exact: true }).click();
  await page.getByRole('button', { name: '查看 v0.1.12 更新说明', exact: true }).click();
  await expect(page.locator('.release-detail pre')).toContainText('<script>unsafe()</script>');
  expect(await page.evaluate(() => 'unsafe' in window)).toBe(false);
  await page.getByRole('button', { name: '返回版本列表', exact: true }).click();
  await page.getByRole('button', { name: `查看 v${version} 更新说明`, exact: true }).click();
  await expect(page.locator('.release-detail')).toContainText('恢复品牌与版本二级菜单');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新日志', exact: true })).toBeFocused();
  const compared = await page.evaluate(() => (window as any).compareVersions('0.1.10', '0.1.9'));
  expect(compared).toBe(1);
});

test('Windows 下载进度与失败可重试，不假报成功；三种尺寸的主题和品牌入口一致', async ({ page }) => {
  await page.route(API, (route) => route.fulfill({ json: release() }));
  await page.goto('http://127.0.0.1:19520?native=windows');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const update = page.getByRole('button', { name: '下载并更新', exact: true });
  await expect(update).toBeEnabled();
  await update.click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '45');
  await expect(page.getByRole('status')).toContainText('签名校验失败');
  await expect(update).toBeEnabled();
  expect(await page.evaluate(() => (window as any).updateInvocations)).toEqual([
    { command: 'install_app_update', version: '0.1.12' },
  ]);
  for (const width of [390, 900, 1440])
    for (const theme of ['day', 'night']) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate((mode) => (document.documentElement.dataset.theme = mode), theme);
      const brand = page.getByRole('button', { name: '关于 Panestra', exact: true });
      await expect(brand).toHaveAttribute('aria-haspopup', 'dialog');
      expect(await brand.getAttribute('title')).toBeNull();
      expect(await page.locator('button.brand, .sidebar-bottom a, .project-link').count()).toBe(0);
      const result = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: Array.from(document.querySelectorAll('.update-actions button')).map((el) => [
          el.getBoundingClientRect().height,
          getComputedStyle(el).borderRadius,
        ]),
      }));
      expect(result.overflow).toBe(false);
      const inset = await page.locator('.update-status').evaluate((el) => ({
        left: getComputedStyle(el).paddingLeft,
        bottom: getComputedStyle(el).paddingBottom,
        textBottom: el.querySelector('span')!.getBoundingClientRect().bottom,
        panelBottom: el.closest('.panel')!.getBoundingClientRect().bottom,
      }));
      expect(inset.left).toBe('25px');
      expect(inset.bottom).toBe('24px');
      expect(inset.panelBottom - inset.textBottom).toBeGreaterThanOrEqual(24);
      expect(result.controls).toEqual([
        [44, '8px'],
        [44, '8px'],
      ]);
      await page.screenshot({
        path: `artifacts/app-updates-${width}-${theme}.png`,
        fullPage: true,
      });
    }
});

test('Android 缺少摘要时禁止更新，完整发布才调用系统安装入口', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: 'Android Panestra test',
    viewport: { width: 900, height: 1200 },
  });
  const page = await context.newPage();
  const data = release();
  data.assets[1].digest = '';
  await page.route(API, (route) => route.fulfill({ json: data }));
  await page.goto('http://127.0.0.1:19520?native=android');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载并更新', exact: true })).toBeDisabled();
  await page.unroute(API);
  await page.route(API, (route) => route.fulfill({ json: release() }));
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '下载并更新', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('请在系统窗口确认安装');
  expect(await page.evaluate(() => (window as any).updateInvocations)).toEqual([
    { command: 'plugin:panestra-bridge|install_app_update', version: '0.1.12' },
  ]);
  await context.close();
});

test('品牌打开关于菜单，日志原位切换，关闭恢复焦点；窄屏和主题均完整显示', async ({ page }) => {
  await page.goto('http://127.0.0.1:19520?native=windows');
  for (const width of [390, 900, 1440])
    for (const theme of ['day', 'night']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((mode) => (document.documentElement.dataset.theme = mode), theme);
      const brand = page.getByRole('button', { name: '关于 Panestra', exact: true });
      await brand.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveCount(1);
      await expect(dialog.locator('.about-version')).toHaveText(`v${version}`);
      await expect(dialog.locator('.about-identity img')).toHaveJSProperty('naturalWidth', 125);
      await expect(dialog).toContainText('ONE CORE, EVERY DEVICE.');
      await expect(dialog).toContainText('Android Surface');
      expect(await page.evaluate(() => (window as any).updateInvocations || [])).toEqual([]);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const actions = dialog.locator('.about-actions button');
      for (const action of await actions.all())
        expect(await action.evaluate((el) => el.getBoundingClientRect().height)).toBe(44);
      await page.screenshot({ path: `artifacts/about-${width}-${theme}.png` });
      await dialog.getByRole('button', { name: '更新日志', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await dialog.getByRole('button', { name: `查看 v${version} 更新说明`, exact: true }).click();
      await expect(dialog.locator('.release-detail')).toContainText('恢复品牌与版本二级菜单');
      await dialog.getByRole('button', { name: '返回版本列表', exact: true }).click();
      await dialog.getByRole('button', { name: '返回关于', exact: true }).click();
      await expect(dialog.locator('.about-version')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(brand).toBeFocused();
    }
  await page.getByRole('button', { name: '关于 Panestra', exact: true }).click();
  await page.getByRole('button', { name: 'GitHub 项目', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GitHub 项目', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).updateInvocations)).toEqual([
    { command: 'plugin:panestra-bridge|open_github' },
  ]);
});
