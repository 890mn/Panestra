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
test('内部内容触摸滑动不会改动预设，独立手柄才触发移位', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    await page.goto(
      'http://127.0.0.1:19519/?type=metric-card&bp=tablet&width=900&w=8&h=5&edit&inner=value&custom',
    );
    const block = page.locator('.widget-card').first().locator('[data-part=value]');
    const handle = block.locator('.part-move');
    await expect(handle).toBeVisible();
    const swipe = async (start: { x: number; y: number }, dx: number, dy: number) => {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1 }],
      });
      for (let i = 1; i <= 10; i++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start.x + (dx * i) / 10, y: start.y + (dy * i) / 10, id: 1 }],
        });
        await page.waitForTimeout(20);
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const content = (await block.boundingBox())!;
    await swipe({ x: content.x + content.width / 2, y: content.y + content.height / 2 }, 3, -100);
    expect(await page.evaluate(() => (window as any).lastInnerChanges)).toBeUndefined();
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    const originalColumn = await block.evaluate(
      (element) => Number(getComputedStyle(element).gridColumnStart) - 1,
    );
    const grip = (await handle.boundingBox())!;
    await swipe({ x: grip.x + 22, y: grip.y + 22 }, originalColumn ? -100 : 100, 0);
    const changes = await page.evaluate(() => (window as any).lastInnerChanges);
    expect(changes.value.column).not.toBe(originalColumn);
    expect(grip.width).toBe(44);
    expect(grip.height).toBe(44);
  } finally {
    await session.detach();
    await context.close();
  }
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
        version: '0.1.27',
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
test('编辑态沿用浏览态内容尺寸，所有 2 列卡片的移动手柄完整可见', async ({ page }) => {
  await page.goto('http://127.0.0.1:19519/');
  const measure = () =>
    page.locator('.widget-card').evaluateAll((cards) =>
      cards.map((card) => {
        const body = card.querySelector('.widget-content')!;
        const heading = card.querySelector('.widget-heading')!;
        const view = card.querySelector('.widget-view')!;
        const rect = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height, x: r.x, y: r.y };
        };
        return {
          card: rect(card),
          body: rect(body),
          heading: rect(heading),
          view: rect(view),
          presentation: view.getAttribute('data-presentation'),
          classes: view.className,
          text: (body as HTMLElement).innerText,
        };
      }),
    );
  for (const [bp, width] of [
    ['desktop', 1200],
    ['tablet', 850],
    ['mobile', 326],
  ] as const)
    for (const type of Object.keys(PRESENTATIONS)) {
      const query = `bp=${bp}&width=${width}&type=${type}&w=2&h=2`;
      await page.evaluate((q) => (window as any).renderPreview(q), query);
      const browsing = await measure();
      await page.evaluate((q) => (window as any).renderPreview(q), query + '&edit');
      await expect.poll(measure).toEqual(browsing);
      for (const handle of await page.locator('.layout-title-move').all()) {
        await handle.scrollIntoViewIfNeeded();
        const result = await handle.evaluate((button) => {
          const r = button.getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            visible: getComputedStyle(button.querySelector('svg')!).display !== 'none',
            hit:
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest('button') === button,
          };
        });
        expect(result, bp + '/' + type).toEqual({
          width: 44,
          height: 44,
          visible: true,
          hit: true,
        });
      }
    }
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
  expect(actions[3].trackId).toBe('test-track');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  for (const suffix of ['&edit', '&offline', '&role=viewer']) {
    await page.evaluate((query) => (window as any).renderPreview(query), query + suffix);
    await expect(page.getByRole('button', { name: '网易云暂停', exact: true })).toBeDisabled();
  }
  expect(actions).toHaveLength(4);
  await page.evaluate((query) => (window as any).renderPreview(query), query + '&readonly');
  await expect(page.getByRole('button', { name: '网易云暂停', exact: true })).toBeDisabled();
  await expect(page.locator('.music-access')).toHaveText('未授权');
  expect(actions).toHaveLength(4);
});

test('音乐拖动松手只发送一次，取消不跳转，切歌后的请求仍携带原歌曲标识', async ({ page }) => {
  const actions: Record<string, unknown>[] = [];
  await page.route('**/api/v1/integrations/netease/actions', async (route) => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const query = 'type=media-control&mode=player&bp=tablet&width=1000&w=8&h=4&control';
  await page.goto('http://127.0.0.1:19519/?' + query);
  const slider = page.getByLabel('播放进度');
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
  expect(actions).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0].trackId).toBe('test-track');
  expect(Number(actions[0].positionSeconds)).toBeGreaterThan(130);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await slider.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
    bubbles: true,
  });
  await page.mouse.up();
  expect(actions).toHaveLength(1);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate((query) => (window as any).renderPreview(query + '&track=next-track'), query);
  await page.mouse.up();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1].trackId).toBe('test-track');
});

test('真实音乐时间轴播放时补间，暂停后停表', async ({ page }) => {
  const query = 'type=media-control&mode=player&bp=tablet&width=1000&w=8&h=4&control&timeline';
  await page.clock.install();
  await page.goto('http://127.0.0.1:19519/?' + query);
  await page.clock.fastForward(1500);
  expect(Number(await page.getByLabel('播放进度').inputValue())).toBeGreaterThan(76);
  await page.evaluate((query) => (window as any).renderPreview(query + '&paused'), query);
  await page.clock.fastForward(1500);
  await expect(page.getByLabel('播放进度')).toHaveValue('75');
});

test('音乐封面右侧保留三个居中按键，未知时长仍显示不可拖动的进度轨道', async ({ page }) => {
  await page.goto(
    'http://127.0.0.1:19519/?type=media-control&mode=cover&bp=tablet&width=1000&w=8&h=4&control',
  );
  const checkHeader = async () => {
    const geometry = await page.locator('.widget-view').evaluate((el) => {
      const cover = el.querySelector('.playback-art')!.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('.music-buttons button')].map((button) =>
        button.getBoundingClientRect(),
      );
      return {
        coverCenter: cover.y + cover.height / 2,
        buttons: buttons.map((r) => ({ center: r.y + r.height / 2, x: r.x, width: r.width })),
        coverRight: cover.right,
        contentRight: el.getBoundingClientRect().right,
        buttonsRight: buttons[buttons.length - 1].right,
      };
    });
    expect(geometry.buttons).toHaveLength(3);
    for (const button of geometry.buttons) {
      expect(Math.abs(button.center - geometry.coverCenter)).toBeLessThanOrEqual(1);
      expect(button.x).toBeGreaterThan(geometry.coverRight);
      expect(button.width).toBe(44);
    }
    expect(Math.abs(geometry.buttonsRight - geometry.contentRight)).toBeLessThanOrEqual(1);
  };
  await checkHeader();
  await expect(page.getByLabel('播放进度')).toBeEnabled();
  await expect(page.locator('.music-time')).toHaveText('1:154:05');
  await page.getByRole('button', { name: '查看网络流量与同步状态详情' }).click();
  const detailAlignment = await page.locator('dialog .music-detail-content').evaluate((el) => {
    const cover = el.querySelector('.playback-art')!.getBoundingClientRect();
    return [...el.querySelectorAll('.music-buttons button')].map((button) => {
      const r = button.getBoundingClientRect();
      return Math.abs(r.y + r.height / 2 - cover.y - cover.height / 2);
    });
  });
  expect(detailAlignment).toHaveLength(3);
  expect(detailAlignment.every((difference) => difference <= 1)).toBe(true);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() =>
    (window as any).renderPreview(
      'type=media-control&mode=cover&bp=tablet&width=650&w=4&h=4&control&noTime',
    ),
  );
  await checkHeader();
  await expect(page.getByLabel('播放进度')).toBeVisible();
  await expect(page.getByLabel('播放进度')).toBeDisabled();
  await expect(page.locator('.music-time')).toContainText('播放器未提供进度');
  await page.screenshot({ path: 'artifacts/music-cover-layout.png' });
});

test('插件可视化使用真实数值，未知额度和余额不生成伪造图表', async ({ page }) => {
  await page.goto('http://127.0.0.1:19519/?type=codex-usage&mode=rings&width=1000&w=8&h=5');
  await expect(page.locator('.quota-ring').first()).toBeVisible();
  await expect(page.locator('.quota-ring').first()).toHaveAttribute('aria-label', /87.5%/);
  await page.evaluate(() =>
    (window as any).renderPreview(
      'type=account-usage&mode=visual&width=1000&w=8&h=5&account=deepseek',
    ),
  );
  await expect(page.locator('.balance-composition').first()).toHaveAttribute(
    'aria-label',
    'CNY 赠送 10.00，充值 100.00',
  );
  await expect(page.locator('.balance-composition')).toHaveCount(1);
  await page.evaluate(() =>
    (window as any).renderPreview('type=proxy-status&mode=trend&width=1000&w=8&h=5'),
  );
  await expect(page.locator('.clash-trend-chart svg').first()).toBeVisible();
  await page.evaluate(() =>
    (window as any).renderPreview('type=task-status&mode=timeline&width=1000&w=8&h=8'),
  );
  await expect(page.locator('.alas-queue.is-timeline')).toBeVisible();
  await page.evaluate(() =>
    (window as any).renderPreview('type=codex-usage&mode=rings&width=1000&w=8&h=5&empty'),
  );
  await expect(page.locator('.quota-ring-value')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/adapter-unknown-quota.png' });
});

test('新增预设使用实际数据，空数据不点亮刻度，黑白主题保持可读', async ({ page }) => {
  await page.goto('http://127.0.0.1:19519/');
  const additions: Record<string, string[]> = {
    'metric-card': ['dial', 'segments', 'bars'],
    'network-chart': ['bars', 'meters'],
    'system-overview': ['tiles'],
    'codex-usage': ['tiles', 'segments'],
    'account-usage': ['tiles', 'segments'],
    'proxy-status': ['route', 'meters'],
    'media-control': ['vinyl', 'focus'],
    'task-status': ['board'],
  };
  for (const theme of ['day', 'night']) {
    for (const [type, modes] of Object.entries(additions))
      for (const mode of modes) {
        await page.evaluate(
          (q) => (window as any).renderPreview(q),
          `type=${type}&mode=${mode}&width=900&w=8&h=5&theme=${theme}`,
        );
        await expect(page.locator('.widget-view')).toHaveAttribute('data-presentation', mode);
        expect(
          await page
            .locator('.widget-content')
            .evaluate(
              (e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1,
            ),
          type + '/' + mode,
        ).toBe(true);
        if (type === 'media-control' && mode === 'focus') {
          const art = (await page.locator('.playback-art').boundingBox())!;
          const copy = (await page.locator('.music-track-copy').boundingBox())!;
          const controls = (await page.locator('.music-buttons').boundingBox())!;
          expect(copy.x).toBeGreaterThanOrEqual(art.x + art.width);
          expect(Math.abs(controls.y + controls.height / 2 - art.y - art.height / 2)).toBeLessThan(
            1,
          );
        }
        await page.screenshot({ path: `artifacts/preset-${type}-${mode}-${theme}.png` });
      }
  }
  for (const [type, mode] of [
    ['metric-card', 'dial'],
    ['metric-card', 'segments'],
    ['network-chart', 'meters'],
    ['codex-usage', 'segments'],
    ['proxy-status', 'meters'],
  ]) {
    await page.evaluate(
      (q) => (window as any).renderPreview(q),
      `type=${type}&mode=${mode}&width=900&w=8&h=5&empty`,
    );
    await expect(page.locator('.dial-fill,.meter-fill')).toHaveCount(0);
  }
  await page.evaluate(
    (q) => (window as any).renderPreview(q),
    'type=codex-usage&mode=segments&width=900&w=8&h=5',
  );
  await expect(page.getByRole('img', { name: '5 小时剩余 87.5%', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '1 周剩余 53.5%', exact: true })).toBeVisible();
  await page.evaluate(
    (q) => (window as any).renderPreview(q),
    'type=account-usage&account=deepseek&mode=segments&width=900&w=8&h=5',
  );
  await expect(page.locator('.balance-composition')).toHaveCount(1);
  await expect(page.locator('.account-values')).toContainText('$-1.00');
});
