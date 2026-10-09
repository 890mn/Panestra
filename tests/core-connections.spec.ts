import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createServer as createTCPServer, connect, type Server, type Socket } from 'node:net';
import path from 'node:path';

let vite: ViteDevServer;
let tunnel: Server;
const sockets = new Set<Socket>();
const children: ChildProcess[] = [];
type TestCore = { uri: string; fingerprint: string; bootstrap: string };
let first: TestCore;
let second: TestCore;
const origin = 'http://127.0.0.1:19523';

async function startCore(port: number): Promise<TestCore> {
  mkdirSync('.tools/connection-tests', { recursive: true });
  const child = spawn(
    path.resolve('artifacts/build/panestra-core.exe'),
    [
      '--data',
      mkdtempSync(path.resolve('.tools/connection-tests/core-')),
      '--listen',
      `127.0.0.1:${port}`,
      '--plugin-seed',
      path.resolve('artifacts/build/plugin-seed'),
      '--origins',
      origin,
      '--parent-stdio',
    ],
    { windowsHide: true },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let bootstrap = '';
    let fingerprint = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Isolated Core startup timed out')), 15000);
    const ready = () => {
      if (!bootstrap || !fingerprint) return;
      clearTimeout(timer);
      resolve({ uri: `https://127.0.0.1:${port}`, fingerprint, bootstrap });
    };
    child.stdout!.on('data', (data) => {
      bootstrap = data.toString().match(/认领码[^:]+: (\S+)/)?.[1] || bootstrap;
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
}

test.beforeAll(async () => {
  [first, second] = await Promise.all([startCore(19521), startCore(19522)]);
  vite = await createServer({
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: {
      include: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        'lucide-react',
        'idb-keyval',
        'qrcode',
        '@tauri-apps/api/core',
        '@tauri-apps/api/event',
      ],
    },
    root: path.resolve('tests/connection-preview'),
    publicDir: path.resolve('client/public'),
    server: { host: '127.0.0.1', port: 19523, strictPort: true, fs: { allow: [process.cwd()] } },
    logLevel: 'error',
  });
  await vite.listen();
  tunnel = createTCPServer((local) => {
    const remote = connect(19521, '127.0.0.1');
    for (const socket of [local, remote]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        local.destroy();
        remote.destroy();
      });
    }
    local.pipe(remote);
    remote.pipe(local);
  });
  await new Promise<void>((resolve) => tunnel.listen(19524, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    vite?.close(),
    tunnel ? new Promise<void>((resolve) => tunnel.close(() => resolve())) : undefined,
    ...children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.kill();
            resolve();
          }, 6000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          child.stdin!.end();
        }),
    ),
  ]);
});

test('真实双 Core：连接入口、切换隔离、失败保留连接、TCP 映射复用配对与持久化', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).connectionCore);
  const claim = async (target: TestCore) => {
    await page.evaluate(async (target) => {
      await (window as any).connectionCore.claim(
        target.uri,
        target.fingerprint,
        target.bootstrap,
        'Connection test device',
        true,
      );
    }, target);
    await expect
      .poll(() => page.evaluate(() => (window as any).connectionCore.state.online))
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => Boolean((window as any).connectionCore.state.snapshot)))
      .toBe(true);
  };
  await claim(first);
  const firstID = await page.evaluate(() => (window as any).connectionCore.state.endpoint.serverId);
  await page.evaluate(async () => {
    const client = (window as any).connectionCore;
    const snapshot = client.state.snapshot;
    const pageEntity = snapshot.entities.find((item: any) => item.kind === 'page');
    await client.command(pageEntity, 'page.update', { title: 'First Core workspace' });
  });
  await claim(second);
  const secondID = await page.evaluate(
    () => (window as any).connectionCore.state.endpoint.serverId,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).connectionFleet.getSnapshot().filter((host: any) => host.state.online)
            .length,
      ),
    )
    .toBe(2);
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.aggregate-host')).toHaveCount(2);
  await expect(page.locator(`[data-host-id="${firstID}"]`)).toContainText('First Core workspace');
  await page.evaluate(async () => {
    const hosts = (window as any).connectionFleet.getSnapshot();
    for (const host of hosts) {
      const pageEntity = host.state.snapshot.entities.find((entity: any) => entity.kind === 'page');
      await host.client.command(pageEntity, 'page.update', {
        title: host.active ? 'Second Core workspace' : 'First Core workspace',
      });
      const processor = host.state.snapshot.entities.find(
        (entity: any) => entity.id === 'widget-cpu',
      );
      host.client.patch({
        telemetry: {
          'system/name': {
            topic: 'system/name',
            value: { hostname: host.active ? 'Travel PC' : 'Home PC' },
          },
          [`${processor.data.pluginId}/${processor.data.source}`]: {
            topic: `${processor.data.pluginId}/${processor.data.source}`,
            value: host.active ? 71 : 13,
          },
        },
      });
    }
  });
  await expect(page.locator(`[data-host-id="${firstID}"] .aggregate-host-name`)).toContainText(
    'Home PC',
  );
  await expect(page.locator(`[data-host-id="${secondID}"] .aggregate-host-name`)).toContainText(
    'Travel PC',
  );
  await expect(page.locator(`[data-host-id="${secondID}"]`)).toContainText('Second Core workspace');
  await expect(page.locator(`[data-host-id="${firstID}"] .metric-value`).first()).toContainText(
    '13',
  );
  await expect(page.locator(`[data-host-id="${secondID}"] .metric-value`).first()).toContainText(
    '71',
  );
  await page.evaluate(async () => {
    const hosts = (window as any).connectionFleet.getSnapshot();
    (window as any).aggregateControlCalls = [];
    (window as any).aggregateOriginalRequests = [];
    for (const host of hosts) {
      const plugin = host.state.plugins.find((item: any) =>
        item.manifest.sources.some((source: any) => source.id === 'media.status'),
      );
      await host.client.command({ id: 'aggregate-music', rev: 0 }, 'widget.create', {
        pageId: 'page-overview',
        type: 'media-control',
        title: 'Music controls',
        pluginId: plugin.id,
        source: 'media.status',
      });
      (window as any).aggregateOriginalRequests.push({
        client: host.client,
        request: host.client.pluginRequest,
      });
      host.client.pluginRequest = async (id: string, operation: string, body: any) => {
        (window as any).aggregateControlCalls.push({ hostId: host.id, id, operation, body });
      };
      host.client.patch({
        telemetry: {
          ...host.client.state.telemetry,
          [`${plugin.id}/media.status`]: {
            topic: `${plugin.id}/media.status`,
            value: {
              enabled: true,
              allowControl: true,
              state: 'ready',
              stale: false,
              playback: 'paused',
              title: 'Scoped song',
              artist: 'Test artist',
              album: 'Test album',
              message: '',
              refreshing: false,
              controls: { toggle: true, previous: true, next: true, seek: true },
              durationSeconds: 180,
              positionSeconds: 30,
              updatedAt: new Date().toISOString(),
              trackId: host.id,
            },
          },
        },
      });
    }
  });
  for (const id of [firstID, secondID]) {
    const card = page.getByTestId(`aggregate-${id}-aggregate-music`);
    await card.getByRole('button', { name: '网易云下一首', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).aggregateControlCalls.at(-1)?.hostId))
      .toBe(id);
  }
  await page.evaluate((id) => {
    const host = (window as any).connectionFleet.getSnapshot().find((item: any) => item.id === id);
    host.client.patch({ device: { ...host.client.state.device, role: 'viewer' } });
  }, firstID);
  await expect(
    page
      .getByTestId(`aggregate-${firstID}-aggregate-music`)
      .getByRole('button', { name: '网易云下一首', exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByTestId(`aggregate-${secondID}-aggregate-music`)
      .getByRole('button', { name: '网易云下一首', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    for (const { client, request } of (window as any).aggregateOriginalRequests)
      client.pluginRequest = request;
  });
  await page.screenshot({ path: 'artifacts/multi-core-overview-day.png', fullPage: true });
  expect((await page.evaluate(() => (window as any).readActiveCore())).serverId).toBe(secondID);
  await page
    .locator(`[data-host-id="${secondID}"]`)
    .getByRole('button', { name: '打开工作区', exact: true })
    .click();
  expect(firstID).not.toBe(secondID);
  await expect(page.getByText('First Core workspace', { exact: true })).toHaveCount(0);
  const entry = page.getByRole('button', { name: '管理 Core 连接', exact: true });
  await entry.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.saved-core')).toHaveCount(2);
  await page.getByRole('button', { name: '添加新 Core', exact: true }).click();
  await expect(page.getByLabel('Core 地址', { exact: true })).toHaveValue('');
  await expect(page.getByLabel(/^Core 身份指纹/)).toHaveValue('');
  await expect(page.getByRole('list', { name: '连接步骤' })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立主机', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回 Core 列表', exact: true }).click();
  await page.getByRole('button', { name: '通过 UU 远程连接', exact: true }).click();
  await expect(page.locator('.core-remote-guide')).toContainText('https://127.0.0.1:19443');
  await expect(page.locator('.core-remote-guide')).toContainText('首次在这台设备连接时');
  await page.getByRole('button', { name: '返回 Core 列表', exact: true }).click();
  await page
    .locator('.saved-core', { hasText: 'Home PC' })
    .getByRole('button', { name: '切换', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'First Core workspace', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).connectionCore.state.online))
    .toBe(true);
  expect(await page.evaluate(() => (window as any).connectionCore.state.identity.serverId)).toBe(
    firstID,
  );
  await entry.click();
  await page.getByRole('button', { name: '添加连接地址', exact: true }).click();
  await page.getByLabel('HTTPS 地址', { exact: true }).fill(second.uri);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('身份指纹不匹配');
  expect(await page.evaluate(() => (window as any).connectionCore.state.endpoint.serverId)).toBe(
    firstID,
  );
  expect(await page.evaluate(() => (window as any).connectionCore.state.online)).toBe(true);
  await page.getByLabel('HTTPS 地址', { exact: true }).fill('https://127.0.0.1:19524/path');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不包含路径');
  await page.getByLabel('HTTPS 地址', { exact: true }).fill('https://127.0.0.1:19524');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).connectionCore.state.online))
    .toBe(true);
  expect(await page.evaluate(() => (window as any).connectionCore.state.endpoint.uri)).toBe(
    'https://127.0.0.1:19524',
  );
  expect(await page.evaluate(() => (window as any).connectionCore.state.endpoint.serverId)).toBe(
    firstID,
  );
  expect(
    await page.evaluate(async () => (await (window as any).connectionCore.api('/devices')).length),
  ).toBe(1);
  await page.reload();
  await expect(entry).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).connectionCore.state.online))
    .toBe(true);
  expect(await page.evaluate(() => (window as any).connectionCore.state.endpoint.uri)).toBe(
    'https://127.0.0.1:19524',
  );
  await entry.click();
  await expect(page.getByRole('button', { name: '2 个连接地址', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/core-connections-day.png' });
  await page.keyboard.press('Escape');
  await expect(entry).toBeFocused();
  await page.getByRole('button', { name: '切换黑夜', exact: true }).click();
  await entry.click();
  await page.screenshot({ path: 'artifacts/core-connections-night.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await page
      .getByRole('button', { name: '添加新 Core', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'artifacts/core-connections-mobile.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 960 });
  // A late response from the old Core must never be consumed by the new session.
  let releaseResponse!: () => Promise<void>;
  let requested = false;
  await page.route('https://127.0.0.1:19524/api/v1/snapshot', async (route) => {
    const response = await route.fetch();
    releaseResponse = async () => {
      await route.fulfill({ response });
    };
    requested = true;
  });
  await page.evaluate(() => {
    const client = (window as any).connectionCore;
    client.patch({
      telemetry: { 'old/private': { topic: 'old/private', value: 97 } },
      history: { 'old/private': [97] },
    });
    (window as any).oldRequest = client.api('/snapshot').then(
      () => 'unexpected success',
      (error: any) => error.message,
    );
  });
  await expect.poll(() => requested).toBe(true);
  await entry.click();
  await page
    .locator('.saved-core', { hasText: '127.0.0.1:19522' })
    .getByRole('button', { name: '切换', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await releaseResponse();
  expect(await page.evaluate(() => (window as any).oldRequest)).toContain('Core 已切换');
  expect(await page.evaluate(() => (window as any).connectionCore.state.endpoint.serverId)).toBe(
    secondID,
  );
  expect(
    await page.evaluate(() => (window as any).connectionCore.state.telemetry['old/private']),
  ).toBeUndefined();
  expect(
    await page.evaluate(() => (window as any).connectionCore.state.history['old/private']),
  ).toBeUndefined();
  await expect(page.getByText('First Core workspace', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.locator('.aggregate-host')).toHaveCount(2);
  await page.evaluate((id) => {
    (window as any).connectionFleet
      .getSnapshot()
      .find((host: any) => host.id === id)
      .client.disconnect();
  }, firstID);
  await expect(page.locator(`[data-host-id="${firstID}"]`)).toHaveAttribute('data-online', 'false');
  await expect(page.locator(`[data-host-id="${secondID}"]`)).toHaveAttribute('data-online', 'true');
  await expect(page.locator(`[data-host-id="${firstID}"]`)).toContainText('缓存');
  await page.screenshot({ path: 'artifacts/multi-core-overview-night.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/multi-core-overview-mobile.png', fullPage: true });
  await page.evaluate(() => (window as any).connectionFleet.resume());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).connectionFleet.getSnapshot().filter((host: any) => host.state.online)
            .length,
      ),
    )
    .toBe(2);
  await page.getByRole('button', { name: '添加或管理主机', exact: true }).click();
  await page
    .locator('.saved-core[data-current]')
    .getByRole('button', { name: /^重命名 Core/ })
    .click();
  await page.getByLabel('Core 备注名称').fill('远程工作站');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-host-id="${secondID}"] .aggregate-host-name`)).toContainText(
    '远程工作站',
  );
  await page.reload();
  await expect(page.locator('.aggregate-host')).toHaveCount(2);
  await expect(page.locator(`[data-host-id="${secondID}"] .aggregate-host-name`)).toContainText(
    '远程工作站',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).connectionFleet.getSnapshot().filter((host: any) => host.state.online)
            .length,
      ),
    )
    .toBe(2);
  expect((await page.evaluate(() => (window as any).readActiveCore())).serverId).toBe(secondID);
  expect(errors).toEqual([]);
});
