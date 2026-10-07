import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  SIZE_PRESETS,
  presetsFor,
  PRESENTATIONS,
} from '../packages/widget-schema/src/presentation';
let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    root: path.resolve('tests/widget-preview'),
    server: { host: '127.0.0.1', port: 19519, strictPort: true, fs: { allow: [process.cwd()] } },
    logLevel: 'error',
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});
test('每种呈现、预制尺寸及自由尺寸均完整适配，无卡片偏移或内部滚动', async ({ page }) => {
  test.setTimeout(300000);
  const failures: string[] = [];
  let checks = 0;
  await page.goto('http://127.0.0.1:19519/');
  await expect(page.locator('.widget-view').first()).toBeVisible();
  for (const [bp, width] of [
    ['desktop', 1000],
    ['tablet', 650],
    ['mobile', 326],
  ] as const) {
    for (const type of Object.keys(PRESENTATIONS)) {
      for (const size of Array.from(
        { length: ({ desktop: 12, tablet: 8, mobile: 4 }[bp] - 1) * 11 },
        (_, i) => ({
          id: `${2 + Math.floor(i / 11)}x${2 + (i % 11)}`,
          w: 2 + Math.floor(i / 11),
          h: 2 + (i % 11),
        }),
      )) {
        await page.evaluate(
          (query) => (window as any).renderPreview(query),
          `bp=${bp}&width=${width}&type=${type}&w=${size.w}&h=${size.h}`,
        );
        await expect(page.locator('.widget-view').first()).toBeVisible();
        const result = await page.locator('.widget-card').evaluateAll((cards) =>
          cards.map((card) => {
            const el = card as HTMLElement,
              body = el.querySelector('.widget-content') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const children = [...body.querySelectorAll('*')].filter(
              (x) =>
                x.getClientRects().length &&
                x.tagName !== 'svg' &&
                x.tagName !== 'path' &&
                x.tagName !== 'polyline',
            );
            const b = body.getBoundingClientRect();
            const outside = children
              .filter((x) => {
                const r = x.getBoundingClientRect();
                return (
                  r.right > b.right + 1 ||
                  r.left < b.left - 1 ||
                  r.bottom > b.bottom + 1 ||
                  r.top < b.top - 1
                );
              })
              .map((x) => x.className || x.tagName);
            const title = el.querySelector('.widget-title')!.getBoundingClientRect(),
              control = el.querySelector('.widget-controls')!.getBoundingClientRect();
            return {
              id: el.dataset.testid,
              margin: getComputedStyle(el).margin,
              top: rect.top,
              expected: parseFloat(el.style.top),
              overflow:
                body.scrollHeight > body.clientHeight + 1 ||
                body.scrollWidth > body.clientWidth + 1,
              outside,
              conflict: title.right > control.left + 1,
            };
          }),
        );
        for (const r of result) {
          checks++;
          if (
            r.margin !== '0px' ||
            Math.abs(r.top - r.expected) > 1 ||
            r.overflow ||
            r.outside.length ||
            r.conflict
          )
            failures.push(`${bp}/${type}/${size.id}/${r.id}: ${JSON.stringify(r)}`);
        }
      }
    }
  }
  console.log(`Checked ${checks} renderer / size / breakpoint combinations`);
  expect(failures).toEqual([]);
  writeFileSync(
    'artifacts/widget-adaptation-result.json',
    JSON.stringify(
      {
        status: 'passed',
        version: '0.1.17',
        combinations: checks,
        breakpoints: ['desktop', 'tablet', 'mobile'],
        allAllowedGridSizes: true,
        allPresentations: true,
        internalOverflow: false,
        cardOffsets: false,
      },
      null,
      2,
    ),
  );
  await page.goto('http://127.0.0.1:19519/?type=network-chart&w=8&h=4');
  await page.screenshot({ path: 'artifacts/widget-presets-network.png', fullPage: true });
});
test('小卡片保留核心双向/双窗口数据，详情完整、夜间与离线状态可读', async ({ page }) => {
  for (const type of ['network-chart', 'codex-usage', 'system-overview']) {
    await page.goto(
      `http://127.0.0.1:19519/?bp=mobile&width=326&type=${type}&w=2&h=2&mode=auto&theme=night&offline`,
    );
    await expect(page.locator('.widget-view')).toBeVisible();
    if (type === 'network-chart') {
      await expect(page.locator('.view-rates')).toContainText('接收');
      await expect(page.locator('.view-rates')).toContainText('发送');
    }
    if (type === 'codex-usage') {
      await expect(page.locator('.view-quota-windows')).toContainText('87.5%');
      await expect(page.locator('.view-quota-windows')).toContainText('53.5%');
    }
    await page.getByRole('button', { name: '查看网络流量与同步状态详情' }).click();
    await expect(page.locator('dialog[open]')).toContainText('Core 离线');
    if (type === 'codex-usage') await expect(page.locator('dialog[open]')).toContainText('重置卡');
    if (type === 'system-overview')
      await expect(page.locator('dialog[open]')).toContainText('Intel(R)');
  }
});

test('所有组件空数据及 Codex 长错误信息的小卡摘要不会溢出', async ({ page }) => {
  for (const type of Object.keys(PRESENTATIONS)) {
    for (const state of type === 'codex-usage' ? ['empty', 'error'] : ['empty']) {
      await page.goto(`http://127.0.0.1:19519/?bp=mobile&width=326&type=${type}&w=2&h=2&${state}`);
      await expect(page.locator('.widget-view').first()).toBeVisible();
      await page.waitForTimeout(70);
      const overflow = await page
        .locator('.widget-content')
        .evaluateAll((elements) =>
          elements.some(
            (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
          ),
        );
      expect(overflow).toBe(false);
      if (state === 'error') {
        await expect(page.locator('.widget-card').first()).toContainText('暂不可用');
      }
    }
  }
});

test('账户组件保留双窗口与双币种，详情显示明细，未知值与欠费不被改成零', async ({ page }) => {
  for (const [bp, width] of [
    ['desktop', 1000],
    ['tablet', 650],
    ['mobile', 326],
  ] as const) {
    for (const account of ['glm', 'deepseek']) {
      for (const size of presetsFor(bp)) {
        await page.goto(
          `http://127.0.0.1:19519/?bp=${bp}&width=${width}&type=account-usage&account=${account}&w=${size.w}&h=${size.h}&theme=night&offline`,
        );
        const values = page.locator('.widget-card').first().locator('.account-values');
        if (account === 'glm') {
          await expect(values).toContainText('87.5%');
          await expect(values).toContainText('53.5%');
        } else {
          await expect(values).toContainText('¥110.00');
          await expect(values).toContainText('$-1.00');
        }
        const overflow = await page
          .locator('.widget-content')
          .evaluateAll((elements) =>
            elements.some(
              (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
            ),
          );
        expect(overflow, `${bp}/${account}/${size.id}`).toBe(false);
      }
      await page.getByRole('button', { name: '查看网络流量与同步状态详情' }).first().click();
      const detail = page.locator('dialog[open]');
      if (account === 'glm') {
        await expect(detail).toContainText('MCP 工具额度');
        await expect(detail).toContainText('服务未提供重置时间');
      } else {
        await expect(detail).toContainText('CNY 赠送 / 充值');
        await expect(detail).toContainText('$-1.00');
      }
      await expect(detail).toContainText('历史数据');
    }
  }
});

test('自定义内部排布：常见尺寸和编辑态不重叠、不溢出', async ({ page }) => {
  await page.goto('http://127.0.0.1:19519/');
  for (const edit of [false, true])
    for (const [bp, width] of [
      ['desktop', 1000],
      ['tablet', 650],
      ['mobile', 326],
    ] as const)
      for (const type of Object.keys(PRESENTATIONS))
        for (const size of presetsFor(bp)) {
          await page.evaluate(
            (query) => (window as any).renderPreview(query),
            `bp=${bp}&width=${width}&type=${type}&w=${size.w}&h=${size.h}&custom${edit ? '&edit&inner' : ''}`,
          );
          await page.waitForTimeout(25);
          const broken = await page.locator('.widget-content').evaluateAll((elements) =>
            elements.map((el) => {
              const rect = el.getBoundingClientRect();
              return [...el.querySelectorAll<HTMLElement>('*')]
                .filter(
                  (child) =>
                    child.getClientRects().length &&
                    !['svg', 'path', 'polyline', 'polygon'].includes(child.tagName),
                )
                .filter((child) => {
                  const r = child.getBoundingClientRect();
                  return (
                    r.right > rect.right + 1 ||
                    r.bottom > rect.bottom + 1 ||
                    r.left < rect.left - 1 ||
                    r.top < rect.top - 1
                  );
                })
                .map((el) => el.dataset.part || el.className);
            }),
          );
          expect(broken.flat(), `${bp}/${type}/${size.id}/edit=${edit}`).toEqual([]);
        }
});

test('音乐小卡保留直接播放，详情支持切歌与进度，编辑、离线与 Viewer 禁止控制', async ({ page }) => {
  const actions: Record<string, unknown>[] = [];
  let reject = false;
  await page.route('**/api/v1/integrations/netease/actions', async (route) => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({
      status: reject ? 403 : 200,
      contentType: 'application/json',
      body: JSON.stringify(reject ? { code: 'FORBIDDEN', message: '播放权限已撤销' } : {}),
    });
  });
  const query = 'type=media-control&mode=player&bp=tablet&w=2&h=2&control';
  await page.goto('http://127.0.0.1:19519/?' + query);
  await page.getByRole('button', { name: '网易云暂停', exact: true }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toEqual({ action: 'toggle' });
  await expect(page.getByRole('button', { name: '网易云下一首', exact: true })).toHaveCount(0);
  reject = true;
  await page.getByRole('button', { name: '网易云暂停', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('播放权限已撤销');
  expect(
    await page.locator('.widget-content').evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await page.getByRole('button', { name: '关闭播放错误提示' }).click();
  reject = false;
  await page.getByRole('button', { name: '查看网络流量与同步状态详情' }).click();
  await page.locator('dialog').getByRole('button', { name: '网易云下一首', exact: true }).click();
  await expect.poll(() => actions.length).toBe(3);
  expect(actions[2]).toEqual({ action: 'next' });
  await page.locator('dialog').getByLabel('播放进度').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => actions.length).toBe(4);
  expect(actions[3].action).toBe('seek');
  expect(actions[3].positionSeconds).toBe(76);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  for (const suffix of ['&edit', '&offline', '&role=viewer']) {
    await page.evaluate((query) => (window as any).renderPreview(query), query + suffix);
    await expect(page.getByRole('button', { name: '网易云暂停', exact: true })).toBeDisabled();
  }
  expect(actions).toHaveLength(4);
});
