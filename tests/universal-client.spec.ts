import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
test.describe.configure({ mode: 'serial' });
const root = process.cwd();
const endpoint = 'https://localhost:19443';
let processCore: ChildProcess;
let bootstrap = '';
let fingerprint = '';
let desktop: Page;
let phone: Page;
let phoneContext: BrowserContext;
let tablet: Page;
let tabletContext: BrowserContext;
let coreData = '';
let errors: string[] = [];
async function startCore() {
  processCore = spawn(
    path.join(root, 'artifacts/panestra-core.exe'),
    [
      '--data',
      coreData,
      '--listen',
      '127.0.0.1:19443',
      '--worker',
      path.join(root, 'artifacts/system-plugin.exe'),
      '--manifest',
      path.join(root, 'plugins/system/manifest.json'),
      '--parent-stdio',
    ],
    {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        PANESTRA_CODEX_EXECUTABLE: path.join(root, 'artifacts/codex-fixture.exe'),
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    let startupLog = '';
    const timer = setTimeout(
      () => reject(new Error('Core startup timed out: ' + startupLog)),
      15000,
    );
    processCore.stdout!.on('data', (data) => {
      const match = data.toString().match(/认领码[^:]+: (\S+)/);
      if (match) bootstrap = match[1];
    });
    processCore.stderr!.on('data', (data) => {
      startupLog += data.toString();
      for (const line of data.toString().split('\n')) {
        try {
          const log = JSON.parse(line);
          if (log.msg === 'Panestra Core ready') {
            fingerprint = log.fingerprint;
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      }
    });
    processCore.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Core exited ${code}: ${startupLog}`));
    });
  });
}
async function stopCore() {
  if (!processCore || processCore.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      processCore.kill();
      resolve();
    }, 6000);
    processCore.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    processCore.stdin!.end();
  });
}
test.beforeAll(async ({ browser }) => {
  mkdirSync(path.join(root, '.tools/ui-tests'), { recursive: true });
  coreData = mkdtempSync(path.join(root, '.tools/ui-tests/core-'));
  await startCore();
  const desktopContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });
  desktop = await desktopContext.newPage();
  desktop.on('pageerror', (error) => errors.push(error.message));
  phoneContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  phone = await phoneContext.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  tabletContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 900, height: 1200 },
    hasTouch: true,
  });
  tablet = await tabletContext.newPage();
  tablet.on('pageerror', (error) => errors.push(error.message));
});
test.afterAll(async () => {
  await stopCore();
  await phoneContext?.close();
  await tabletContext?.close();
  await desktop?.context().close();
});
test('真实 Core：三端配对、实时数据、独立布局、重启恢复与撤销', async () => {
  for (const [label, surface] of [
    ['desktop', desktop],
    ['phone', phone],
    ['tablet', tablet],
  ] as const) {
    await surface.goto(endpoint);
    await expect(surface.locator('.brand-name')).toHaveText('Panestra');
    await expect(surface.locator('.connect-story h1')).toContainText('在每一块屏幕上。');
    await expect(surface.locator('.connect-story .eyebrow')).toHaveText('ONE CORE, EVERY DEVICE.');
    await expect(surface.locator('.connect-screen > footer')).toHaveCount(0);
    await expect(surface.getByRole('button', { name: '建立主机', exact: true })).toBeVisible();
    await expect(surface.getByRole('button', { name: '配对此设备', exact: true })).toBeVisible();
    const card = await surface.locator('.connect-card').boundingBox();
    if (label !== 'phone')
      expect(
        Math.abs(card!.y + card!.height / 2 - surface.viewportSize()!.height / 2),
      ).toBeLessThan(20);
    for (const mode of ['day', 'night'] as const) {
      const badge = await surface.locator('.brand-version').evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          background: style.backgroundColor,
          color: style.color,
          radius: style.borderRadius,
          text: getComputedStyle(document.body).color,
          backdrop: getComputedStyle(document.body).backgroundColor,
        };
      });
      expect(badge.background).toBe(badge.text);
      expect(badge.color).toBe(badge.backdrop);
      expect(badge.radius).toBe('6px');
      await surface.screenshot({
        path: `artifacts/connection-${label}-${mode}-0.1.10.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await surface.getByRole('button', { name: '切换主题', exact: true }).click();
    }
    expect(
      await surface.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${label} 连接页`,
    ).toBe(true);
    await surface.screenshot({
      path: `artifacts/connection-${label}-0.1.10.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await desktop.goto(endpoint);
  await desktop.getByLabel('Core 身份指纹').fill(fingerprint);
  await desktop.getByLabel('首次认领码').fill(bootstrap);
  await desktop.getByLabel('此设备名称').fill('测试桌面');
  await desktop.getByRole('button', { name: '建立并进入工作空间' }).click();
  await expect(desktop.getByTestId('widget-cpu')).toBeVisible();
  await desktop.getByRole('button', { name: '插件', exact: true }).click();
  await desktop.getByLabel('读取系统指标').check();
  await desktop.getByRole('button', { name: '授权并启用' }).click();
  await desktop.getByRole('button', { name: '总览', exact: true }).click();
  await expect(desktop.getByTestId('widget-cpu').locator('.metric-value')).not.toContainText('—', {
    timeout: 15000,
  });
  await expect(desktop.getByTestId('widget-cpu').locator('.view-chart')).toBeVisible({
    timeout: 15000,
  });
  await expect(desktop.locator('.toast')).not.toBeVisible({ timeout: 10000 });
  await desktop.screenshot({
    path: 'artifacts/desktop-day.png',
    fullPage: true,
    animations: 'disabled',
  });
  await desktop.getByRole('button', { name: '切换黑夜' }).click();
  await expect(desktop.locator('html')).toHaveAttribute('data-theme', 'night');
  await desktop.screenshot({
    path: 'artifacts/desktop-night.png',
    fullPage: true,
    animations: 'disabled',
  });
  await desktop.getByRole('button', { name: '切换白昼' }).click();
  await desktop.getByRole('button', { name: '设备与连接', exact: true }).click();
  await desktop.getByRole('button', { name: '添加设备', exact: true }).click();
  const code = await desktop.locator('.pairing-code').innerText();
  await phone.goto(endpoint);
  await phone.getByRole('button', { name: '配对此设备', exact: true }).click();
  await phone.getByLabel('Core 身份指纹').fill('0'.repeat(64));
  await phone.getByLabel('配对码', { exact: true }).fill(code);
  await phone.getByLabel('此设备名称').fill('测试手机');
  await phone.getByRole('button', { name: '发送配对请求' }).click();
  await expect(phone.getByRole('alert')).toContainText('指纹不匹配');
  await phone.getByLabel('Core 身份指纹').fill(fingerprint);
  await phone.getByRole('button', { name: '发送配对请求' }).click();
  await expect(desktop.getByText('测试手机 请求连接')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '允许查看与编辑' }).click();
  await expect(phone.getByTestId('widget-cpu')).toBeVisible({ timeout: 15000 });
  await phone.screenshot({
    path: 'artifacts/mobile-day.png',
    fullPage: true,
    animations: 'disabled',
  });
  await desktop.getByRole('button', { name: '添加设备', exact: true }).click();
  const tabletCode = await desktop.locator('.pairing-code').innerText();
  await tablet.goto(endpoint);
  await tablet.getByRole('button', { name: '配对此设备', exact: true }).click();
  await tablet.getByLabel('Core 身份指纹').fill(fingerprint);
  await tablet.getByLabel('配对码', { exact: true }).fill(tabletCode);
  await tablet.getByLabel('此设备名称').fill('测试平板');
  await tablet.getByRole('button', { name: '发送配对请求' }).click();
  await expect(desktop.getByText('测试平板 请求连接')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '允许查看与编辑' }).click();
  await expect(tablet.getByTestId('widget-cpu')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '总览', exact: true }).click();
  await phone.getByRole('button', { name: '配置处理器', exact: true }).click();
  await phone.getByLabel('名称', { exact: true }).fill('共同的处理器');
  await phone.getByRole('button', { name: '保存配置' }).click();
  await expect(
    desktop.getByTestId('widget-cpu').getByRole('heading', { name: '共同的处理器' }),
  ).toBeVisible();
  await desktop.getByRole('button', { name: '编辑布局', exact: true }).click();
  await desktop.getByRole('button', { name: '配置共同的处理器', exact: true }).click();
  await desktop.getByLabel('行', { exact: true }).fill('8');
  await desktop.getByRole('button', { name: '保存配置' }).click();
  await expect(desktop.getByTestId('widget-cpu')).toHaveCSS('top', '672px');
  await expect(phone.getByTestId('widget-cpu')).toHaveCSS('top', '0px');
  await expect(tablet.getByTestId('widget-cpu')).toHaveCSS('top', '0px');
  await tablet.getByRole('button', { name: '配置内存', exact: true }).click();
  await tablet.getByLabel('名称', { exact: true }).fill('平板编辑的内存');
  await tablet.getByRole('button', { name: '保存配置' }).click();
  await expect(
    phone.getByTestId('widget-memory').getByRole('heading', { name: '平板编辑的内存' }),
  ).toBeVisible();
  await expect(
    desktop.getByTestId('widget-memory').getByRole('heading', { name: '平板编辑的内存' }),
  ).toBeVisible();
  await tablet.locator('.toast').waitFor({ state: 'hidden', timeout: 10000 });
  await tablet.screenshot({
    path: 'artifacts/tablet-day.png',
    fullPage: true,
    animations: 'disabled',
  });
  await desktop.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect(desktop.getByTestId('widget-cpu')).toHaveCSS('top', '0px');
  await desktop.getByRole('button', { name: '重做布局', exact: true }).click();
  await expect(desktop.getByTestId('widget-cpu')).toHaveCSS('top', '672px');
  await phone.reload();
  await expect(
    phone.getByTestId('widget-cpu').getByRole('heading', { name: '共同的处理器' }),
  ).toBeVisible();
  await phone.getByRole('button', { name: '编辑布局', exact: true }).click();
  await phone.getByLabel('布局断点').selectOption('desktop');
  await expect(phone.getByTestId('widget-cpu')).toHaveCSS('top', '672px');
  await phone.getByLabel('布局断点').selectOption('mobile');
  await expect(phone.getByTestId('widget-cpu')).toHaveCSS('top', '0px');
  await phone.getByRole('button', { name: '打开菜单', exact: true }).click();
  await phone.getByRole('button', { name: '设备与连接', exact: true }).click();
  await phone.getByRole('button', { name: '连接其他 Core', exact: true }).click();
  await phone.getByLabel('配对码', { exact: true }).fill('EXISTINGDEVICE');
  await phone.getByRole('button', { name: '发送配对请求', exact: true }).click();
  await expect(phone.locator('dialog[open]')).not.toBeVisible();
  await phone.getByRole('button', { name: '打开菜单', exact: true }).click();
  await phone.getByRole('button', { name: '总览', exact: true }).click();
  const originalFingerprint = fingerprint;
  await stopCore();
  await expect(desktop.locator('.offline-banner')).toBeVisible();
  let authenticationAttempts = 0;
  await desktop.route('**/api/v1/auth/challenge', async (route) => {
    authenticationAttempts++;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await startCore();
  expect(fingerprint).toBe(originalFingerprint);
  await desktop.evaluate(() => {
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await expect(desktop.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  expect(authenticationAttempts, '并发前台与网络恢复只进行一次认证').toBe(1);
  await desktop.unroute('**/api/v1/auth/challenge');
  await expect(phone.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  await expect(tablet.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  await expect(desktop.getByTestId('widget-cpu')).toHaveCSS('top', '672px');
  await expect(tablet.getByTestId('widget-cpu')).toHaveCSS('top', '0px');
  await expect(
    phone.getByTestId('widget-memory').getByRole('heading', { name: '平板编辑的内存' }),
  ).toBeVisible();
  await desktop.getByRole('button', { name: '设备与连接', exact: true }).click();
  await desktop.getByRole('button', { name: '撤销测试手机', exact: true }).click();
  await desktop.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(phone.getByRole('button', { name: '编辑布局', exact: true })).toBeDisabled({
    timeout: 10000,
  });
  await expect(phone.locator('.offline-banner')).toContainText('授权已被撤销', { timeout: 15000 });
  await expect(phone.getByRole('button', { name: '重新配对', exact: true })).toBeVisible();
  await desktop.getByRole('button', { name: '添加设备', exact: true }).click();
  const rePairCode = await desktop.locator('.pairing-code').innerText();
  await phone.getByRole('button', { name: '重新配对', exact: true }).click();
  await phone.getByLabel('配对码', { exact: true }).fill(rePairCode);
  await phone.getByLabel('此设备名称').fill('重新批准的手机');
  await phone.getByRole('button', { name: '发送配对请求', exact: true }).click();
  await expect(phone.getByText('等待 Core 本机确认', { exact: false })).toBeVisible();
  await expect(phone.getByRole('button', { name: '编辑布局', exact: true })).toBeDisabled();
  await expect(desktop.getByText('重新批准的手机 请求连接')).toBeVisible({ timeout: 15000 });
  await desktop.getByRole('button', { name: '允许查看与编辑', exact: true }).click();
  await expect(phone.locator('dialog[open]')).not.toBeVisible({ timeout: 15000 });
  await expect(phone.locator('.live-pill')).toContainText('实时同步');
  await expect(phone.getByRole('button', { name: '编辑布局', exact: true })).toBeEnabled();
  await expect(
    phone.getByTestId('widget-memory').getByRole('heading', { name: '平板编辑的内存' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('全局一致性：三种屏幕、黑白主题、适配目录与按键反馈', async () => {
  for (const [label, surface] of [
    ['desktop', desktop],
    ['phone', phone],
    ['tablet', tablet],
  ] as const) {
    const navigate = async (name: string) => {
      const menu = surface.getByRole('button', { name: '打开菜单', exact: true });
      if (await menu.isVisible()) await menu.click();
      await surface.getByRole('button', { name, exact: true }).click();
    };
    for (const theme of ['白昼', '黑夜'] as const) {
      await navigate('设置');
      await expect(surface.locator('.brand-slogan')).toHaveText('ONE CORE, EVERY DEVICE.');
      const projectLink = surface.getByRole('link', { name: 'Panestra GitHub' });
      await expect(projectLink).toHaveAttribute('href', 'https://github.com/890mn/Panestra');
      await expect(projectLink).toHaveAttribute('target', '_blank');
      await expect(projectLink.locator('.github-badge')).toHaveCount(1);
      if (label === 'desktop' && theme === '白昼') {
        await surface.context().route('https://github.com/890mn/Panestra', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<title>Project navigation test</title>',
          }),
        );
        const popup = surface.waitForEvent('popup');
        await projectLink.click();
        const projectPage = await popup;
        await expect(projectPage).toHaveURL('https://github.com/890mn/Panestra');
        await projectPage.close();
        await surface.context().unroute('https://github.com/890mn/Panestra');
      }
      await expect(
        surface.locator('.workspace-picker, .user-avatar, .heading-dot, .health-grid'),
      ).toHaveCount(0);
      await expect(surface.getByText('此设备的偏好', { exact: true })).toBeVisible();
      await expect(surface.getByRole('heading', { name: 'Core 与安全审计' })).toHaveCount(0);
      expect(await surface.locator('main').innerText()).not.toContain('。');
      expect(await surface.locator('.breadcrumbs').innerText()).not.toContain('/');
      await surface.getByRole('button', { name: theme, exact: true }).click();
      const sample = surface.getByRole('button', { name: '保持选中', exact: true });
      await sample.click();
      await expect(sample).toHaveAttribute('aria-pressed', 'true');
      await sample.click();
      await expect(sample).toHaveAttribute('aria-pressed', 'false');
      const feedback = surface.getByRole('button', { name: '测试反馈', exact: true });
      await feedback.click();
      await expect(feedback).toHaveAttribute('aria-busy', 'true');
      await expect(feedback).toBeDisabled();
      await expect(feedback).toBeEnabled();
      await navigate('插件');
      await expect(surface.locator('.adapter-card')).toHaveCount(5);
      await expect(surface.getByTestId('codex-adapter').locator('.adapter-state')).toHaveText(
        '未启用',
      );
      await expect(
        surface.locator('.adapter-card:not([data-testid="codex-adapter"]) .adapter-state'),
      ).toHaveText(Array(4).fill('未接入'));
      await surface.getByRole('button', { name: '控制', exact: true }).click();
      await expect(surface.locator('.adapter-card')).toHaveCount(2);
      await surface.getByRole('button', { name: '状态', exact: true }).click();
      await expect(surface.locator('.adapter-card')).toHaveCount(3);
      await surface.getByRole('button', { name: '全部', exact: true }).click();
      await surface.getByRole('button', { name: '查看ALAS接入设计', exact: true }).click();
      await expect(surface.locator('dialog[open]')).toContainText('ProcessManager');
      await surface.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(
        surface.getByRole('button', { name: '查看ALAS接入设计', exact: true }),
      ).toBeFocused();
      const geometry = await surface.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        wrongControls: Array.from(
          document.querySelectorAll<HTMLElement>('.signature-button, .icon-button'),
        )
          .filter(
            (el) =>
              el.getClientRects().length && Math.abs(el.getBoundingClientRect().height - 44) > 0.1,
          )
          .map((el) => ({ text: el.textContent, height: el.getBoundingClientRect().height })),
        cardHeights: Array.from(document.querySelectorAll<HTMLElement>('.adapter-card')).map(
          (el) => el.getBoundingClientRect().height,
        ),
      }));
      expect(geometry.overflow, `${label} ${theme} 横向溢出`).toBe(false);
      expect(geometry.wrongControls, `${label} ${theme} 控件尺寸`).toEqual([]);
      if (label !== 'phone') expect(geometry.cardHeights[0]).toBe(geometry.cardHeights[1]);
      await surface.screenshot({
        path: `artifacts/ui-${label}-${theme === '白昼' ? 'day' : 'night'}-adapters.png`,
        fullPage: true,
        animations: 'disabled',
      });
      for (const route of ['设备与连接', '总览']) {
        await navigate(route);
        expect(
          await surface.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${label} ${route}`,
        ).toBe(true);
      }
    }
  }
  await desktop.emulateMedia({ reducedMotion: 'reduce' });
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.getByRole('button', { name: '测试反馈', exact: true }).click();
  await expect(
    desktop.getByRole('button', { name: '测试反馈', exact: true }).locator('.button-status'),
  ).toHaveCSS('animation-name', 'none');
  expect(errors).toEqual([]);
});

test('Codex 适配：权限、多额度桶、空值、组件同步和停用清理', async () => {
  const navigate = async (surface: Page, name: string) => {
    const menu = surface.getByRole('button', { name: '打开菜单', exact: true });
    if (await menu.isVisible()) await menu.click();
    await surface.getByRole('button', { name, exact: true }).click();
  };
  await navigate(desktop, '插件');
  await desktop.getByRole('button', { name: '查看Codex额度与设置' }).click();
  await expect(desktop.locator('dialog[open]')).toContainText('任务运行状态尚未接入');
  await desktop.getByRole('button', { name: '授权并启用额度读取', exact: true }).click();
  await expect(desktop.locator('dialog[open] .codex-summary')).toContainText('已接入');
  await expect(desktop.locator('dialog[open]')).toContainText('63%');
  await expect(desktop.locator('dialog[open]')).toContainText('剩余 —');
  await expect(desktop.locator('dialog[open]')).toContainText('Model reserve');
  await expect(desktop.locator('dialog[open] .codex-credit-row')).toContainText('2 张');
  await desktop.getByRole('button', { name: '关闭', exact: true }).click();
  await stopCore();
  await startCore();
  await expect(desktop.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  await expect(desktop.getByTestId('codex-adapter')).toContainText('已接入');
  await navigate(tablet, '插件');
  await tablet.getByRole('button', { name: '查看Codex额度与设置' }).click();
  await expect(tablet.locator('dialog[open]')).toContainText('63%');
  await expect(tablet.getByRole('button', { name: '停用读取', exact: true })).toBeDisabled();
  await tablet.getByRole('button', { name: '刷新额度', exact: true }).click();
  await tablet.getByRole('button', { name: '关闭', exact: true }).click();
  await navigate(desktop, '总览');
  await desktop.getByRole('button', { name: '添加组件', exact: true }).click();
  await desktop.getByRole('button', { name: /Codex 额度.*添加/ }).click();
  await desktop.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(desktop.locator('.widget-card[data-widget-type="codex-usage"]')).toContainText(
    '63%',
  );
  await navigate(tablet, '总览');
  await expect(tablet.locator('.widget-card[data-widget-type="codex-usage"]')).toContainText('63%');
  await desktop.screenshot({ path: 'artifacts/codex-test-workspace.png', fullPage: true });
  await navigate(desktop, '插件');
  await desktop.getByRole('button', { name: '查看Codex额度与设置' }).click();
  for (const theme of ['day', 'night']) {
    await desktop.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    expect(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await desktop.screenshot({ path: `artifacts/codex-test-${theme}.png`, fullPage: true });
  }
  await desktop.getByRole('button', { name: '停用读取', exact: true }).click();
  await expect(desktop.locator('dialog[open] .codex-summary')).toContainText('未启用');
  await expect(desktop.locator('dialog[open]')).not.toContainText('63%');
  await desktop.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(tablet.locator('.widget-card[data-widget-type="codex-usage"]')).not.toContainText(
    '63%',
  );
  expect(errors).toEqual([]);
});

test('触摸编辑：拖动交换、整组撤销、缩放、取消和标题避让', async () => {
  await tablet.getByRole('button', { name: '总览', exact: true }).click();
  await tablet.getByRole('button', { name: '编辑布局', exact: true }).click();
  await tablet.getByLabel('布局断点').selectOption('tablet');
  expect(
    await tablet.locator('.canvas-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const cpu = tablet.getByTestId('widget-cpu');
  const memory = tablet.getByTestId('widget-memory');
  const cpuTitle = await cpu.getByRole('heading').innerText();
  const handle = cpu.getByRole('button', { name: `拖动${cpuTitle}`, exact: true });
  const initial = await cpu.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
    width: (el as HTMLElement).style.width,
    height: (el as HTMLElement).style.height,
  }));
  const memoryLeft = await memory.evaluate((el) => (el as HTMLElement).style.left);
  expect(await handle.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  const session = await tablet.context().newCDPSession(tablet);
  const touch = async (
    start: { x: number; y: number },
    end: { x: number; y: number },
    cancel = false,
  ) => {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...start, id: 1 }],
    });
    for (let i = 1; i <= 10; i++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * i) / 10,
            y: start.y + ((end.y - start.y) * i) / 10,
            id: 1,
          },
        ],
      });
      await tablet.waitForTimeout(20);
    }
    await session.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    });
  };
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await memory.locator('.layout-move').boundingBox();
  await touch(
    { x: from!.x + from!.width / 2, y: from!.y + 22 },
    { x: to!.x + to!.width / 2, y: to!.y + 22 },
  );
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(memoryLeft);
  await expect
    .poll(() => memory.evaluate((el) => (el as HTMLElement).style.left))
    .toBe(initial.left);
  await tablet.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(initial.left);
  await expect.poll(() => memory.evaluate((el) => (el as HTMLElement).style.left)).toBe(memoryLeft);
  await tablet.getByRole('button', { name: '重做布局', exact: true }).click();
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(memoryLeft);
  await tablet.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(initial.left);
  const resize = cpu.getByRole('button', { name: `调整${cpuTitle}尺寸`, exact: true });
  await resize.scrollIntoViewIfNeeded();
  const resizeBox = await resize.boundingBox();
  await touch(
    { x: resizeBox!.x + resizeBox!.width / 2, y: resizeBox!.y + 22 },
    { x: resizeBox!.x + resizeBox!.width / 2, y: resizeBox!.y + 106 },
  );
  await expect(cpu).toHaveCSS('height', '320px');
  await tablet.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect(cpu).toHaveCSS('height', initial.height);
  await handle.scrollIntoViewIfNeeded();
  const cancelBox = await handle.boundingBox();
  await touch(
    { x: cancelBox!.x + cancelBox!.width / 2, y: cancelBox!.y + 22 },
    { x: cancelBox!.x + cancelBox!.width / 2, y: cancelBox!.y + 190 },
    true,
  );
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.top)).toBe(initial.top);
  await handle.click();
  await tablet.getByRole('button', { name: '交换卡片', exact: true }).click();
  await tablet
    .locator('dialog[open]')
    .getByRole('button', { name: await memory.getByRole('heading').innerText(), exact: false })
    .click();
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(memoryLeft);
  await tablet.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect.poll(() => cpu.evaluate((el) => (el as HTMLElement).style.left)).toBe(initial.left);
  const geometry = await tablet.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.widget-card.editable')).map((card) => {
      const title = card.querySelector('h3')!.getBoundingClientRect(),
        config = card.querySelector('.widget-controls')!.getBoundingClientRect();
      const tools = Array.from(
        card.querySelectorAll<HTMLElement>('.layout-title-move, .layout-corner-resize'),
      ).map((button) => ({
        height: button.getBoundingClientRect().height,
        touch: getComputedStyle(button).touchAction,
      }));
      return { titleOverlapsButtons: title.right > config.left + 0.1, tools };
    }),
  );
  expect(
    geometry.every(
      (card) =>
        !card.titleOverlapsButtons &&
        card.tools.every((tool) => tool.height === 44 && tool.touch === 'none'),
    ),
  ).toBe(true);
  await tablet.screenshot({ path: 'artifacts/layout-editor-tablet.png', fullPage: true });
  await tablet.getByRole('button', { name: '浏览', exact: true }).click();
  await session.detach();
  expect(errors).toEqual([]);
});

test('预制尺寸与呈现：配置同步、摘要详情与尺寸整组撤销', async () => {
  const cpu = tablet.getByTestId('widget-cpu');
  const title = await cpu.getByRole('heading').innerText();
  await tablet.getByRole('button', { name: `配置${title}`, exact: true }).click();
  const dialog = tablet.locator('dialog[open]');
  await dialog.getByRole('button', { name: /详情.*4 × 4/ }).click();
  await dialog.getByLabel('呈现方式').selectOption('gauge');
  await expect(dialog.locator('.widget-view')).toHaveAttribute('data-presentation', 'gauge');
  await dialog.getByLabel('趋势效果').selectOption('area');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(cpu).toHaveCSS('height', '320px');
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'gauge');
  await desktop.getByRole('button', { name: '总览', exact: true }).click();
  await desktop.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(desktop.getByTestId('widget-cpu').locator('.widget-view')).toHaveAttribute(
    'data-presentation',
    'auto',
  );
  await tablet.getByRole('button', { name: `查看${title}详情`, exact: true }).click();
  await expect(tablet.locator('dialog[open]')).toContainText('最高');
  await tablet.getByRole('button', { name: '关闭', exact: true }).click();
  await tablet.getByRole('button', { name: '编辑布局', exact: true }).click();
  await cpu.locator('.layout-move').click();
  const previous = await cpu.evaluate((el) => ({
    width: (el as HTMLElement).style.width,
    height: (el as HTMLElement).style.height,
  }));
  await tablet.getByLabel('预制尺寸').selectOption('mini');
  await expect(cpu).toHaveCSS('height', '152px');
  await tablet.getByRole('button', { name: '撤销布局', exact: true }).click();
  await expect
    .poll(() =>
      cpu.evaluate((el) => ({
        width: (el as HTMLElement).style.width,
        height: (el as HTMLElement).style.height,
      })),
    )
    .toEqual(previous);
  await tablet.getByRole('button', { name: '浏览', exact: true }).click();
  expect(errors).toEqual([]);
});

test('原位预览、内部排布与每个尺寸独立保存和取消', async () => {
  const cpu = tablet.getByTestId('widget-cpu');
  await tablet.getByRole('button', { name: '编辑布局', exact: true }).click();
  await cpu.locator('.layout-move').click();
  await expect(cpu.locator('.metric-value')).toBeVisible();
  await tablet.getByLabel('当前尺寸呈现方式').selectOption('gauge');
  await tablet.getByRole('button', { name: '编辑卡片内部', exact: true }).click();
  await tablet.getByRole('button', { name: '数值', exact: true }).click();
  await tablet.getByLabel('内容对齐').selectOption('end');
  await expect(cpu.locator('[data-part=value]')).toHaveAttribute('data-align', 'end');
  await tablet.getByLabel('内容占用列数').fill('6');
  const block = cpu.locator('[data-part=value]');
  await block.scrollIntoViewIfNeeded();
  const rect = await block.boundingBox();
  const cdp = await tablet.context().newCDPSession(tablet);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: rect!.x + 8, y: rect!.y + 10, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: rect!.x + 70, y: rect!.y + 10, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(tablet.getByLabel('内容左侧列')).not.toHaveValue('0');
  await cdp.detach();
  await tablet.screenshot({ path: 'artifacts/layout-live-content-editor.png', fullPage: true });
  await tablet.getByRole('button', { name: '保存当前尺寸预设', exact: true }).click();
  await expect(
    tablet.getByRole('button', { name: '保存当前尺寸预设', exact: true }),
  ).toBeDisabled();
  await tablet.getByRole('button', { name: '结束内容编辑', exact: true }).click();
  await tablet.getByLabel('预制尺寸').selectOption('mini');
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'auto');
  await tablet.getByLabel('当前尺寸呈现方式').selectOption('value');
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'value');
  await tablet.getByRole('button', { name: '取消预览', exact: true }).click();
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'auto');
  await tablet.getByLabel('预制尺寸').selectOption('detail');
  await expect(cpu.locator('[data-part=value]')).toHaveAttribute('data-align', 'end');
  await tablet.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(cpu.locator('[data-part=value]')).toHaveAttribute('data-align', 'end');
  expect(errors).toEqual([]);
});

test('并发预设修改不覆盖较新的远端样式，冲突后仍可取消预览', async () => {
  const cpu = tablet.getByTestId('widget-cpu');
  await tablet.getByRole('button', { name: '编辑布局', exact: true }).click();
  await cpu.locator('.layout-move').click();
  await tablet.getByLabel('当前尺寸呈现方式').selectOption('trend');
  await desktop.getByRole('button', { name: '编辑布局', exact: true }).click();
  await desktop.getByLabel('布局断点').selectOption('tablet');
  await desktop.getByTestId('widget-cpu').locator('.layout-move').click();
  await desktop.getByLabel('当前尺寸呈现方式').selectOption('value');
  await desktop.getByRole('button', { name: '保存当前尺寸预设', exact: true }).click();
  await expect(
    desktop.getByRole('button', { name: '保存当前尺寸预设', exact: true }),
  ).toBeDisabled();
  await tablet.getByRole('button', { name: '保存当前尺寸预设', exact: true }).click();
  await expect(tablet.locator('.profile-controls [role=alert]')).toBeVisible();
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'trend');
  await tablet.getByRole('button', { name: '取消预览', exact: true }).click();
  await expect(cpu.locator('.widget-view')).toHaveAttribute('data-presentation', 'value');
  await tablet.getByRole('button', { name: '浏览', exact: true }).click();
  await desktop.getByRole('button', { name: '浏览', exact: true }).click();
  expect(errors).toEqual([]);
});
