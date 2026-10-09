import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const origin = 'http://127.0.0.1:19603';
test.use({ actionTimeout: 15000 });
const children: ChildProcess[] = [];
let vite: ViteDevServer;
type Fixture = { uri: string; fingerprint: string; bootstrap: string };
let gateway: Fixture;
let upstream: Fixture;
async function start(port: number): Promise<Fixture> {
  mkdirSync('.tools/relay-tests', { recursive: true });
  const child = spawn(
    path.resolve('artifacts/build/panestra-core.exe'),
    [
      '--data',
      mkdtempSync(path.resolve('.tools/relay-tests/core-')),
      '--listen',
      `127.0.0.1:${port}`,
      '--origins',
      origin,
      '--plugin-seed',
      path.resolve('artifacts/build/plugin-seed'),
      '--parent-stdio',
    ],
    { windowsHide: true },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let bootstrap = '';
    let fingerprint = '';
    let log = '';
    const timer = setTimeout(() => reject(new Error('Relay fixture startup timed out')), 15000);
    const ready = () => {
      if (bootstrap && fingerprint) {
        clearTimeout(timer);
        resolve({ uri: `https://127.0.0.1:${port}`, bootstrap, fingerprint });
      }
    };
    child.stdout!.on('data', (data) => {
      bootstrap = data.toString().match(/认领码[^:]+: (\S+)/)?.[1] || bootstrap;
      ready();
    });
    child.stderr!.on('data', (data) => {
      log += data.toString();
      for (const line of log.split('\n')) {
        try {
          const item = JSON.parse(line);
          if (item.msg === 'Panestra Core ready') fingerprint = item.fingerprint;
        } catch {
          /* partial log */
        }
      }
      ready();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Relay fixture exited'));
    });
  });
}
test.beforeAll(async () => {
  [gateway, upstream] = await Promise.all([start(19601), start(19602)]);
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
    server: { host: '127.0.0.1', port: 19603, strictPort: true, fs: { allow: [process.cwd()] } },
    logLevel: 'error',
  });
  await vite.listen();
});
test.afterAll(async () => {
  await vite?.close();
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
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
  );
});

test('移动设备仅访问中转 Core，摘要、独立工作区、控制权限与撤销授权', async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).connectionCore);
  for (const target of [upstream, gateway]) {
    await page.evaluate(async (target) => {
      await (window as any).connectionCore.claim(
        target.uri,
        target.fingerprint,
        target.bootstrap,
        'Gateway owner',
        true,
      );
    }, target);
    await expect
      .poll(() => page.evaluate(() => (window as any).connectionCore.state.online))
      .toBe(true);
    await page.evaluate(async () => {
      const client = (window as any).connectionCore;
      await client.api('/plugins/system', { enabled: true, metrics: true, lock: false });
      await client.loadPlugins();
    });
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).connectionFleet.getSnapshot().filter((host: any) => host.state.online)
            .length,
      ),
    )
    .toBe(2);
  const ids = await page.evaluate(() =>
    (window as any).connectionFleet
      .getSnapshot()
      .map((host: any) => ({ id: host.id, uri: host.state.endpoint.uri })),
  );
  const remoteId = ids.find((item: any) => item.uri.endsWith('19602')).id;
  const gatewayId = ids.find((item: any) => item.uri.endsWith('19601')).id;
  await page.evaluate(async (remoteId) => {
    const client = (window as any).connectionFleet
      .getSnapshot()
      .find((host: any) => host.id === remoteId).client;
    const entity = client.state.snapshot.entities.find((entity: any) => entity.kind === 'page');
    await client.command(entity, 'page.update', { title: '远端工作区' });
  }, remoteId);
  const mobileContext = await browser.newContext({
    viewport: { width: 900, height: 700 },
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  const mobile = await mobileContext.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  const directRemoteRequests: string[] = [];
  mobile.on('websocket', (socket) => {
    if (socket.url().includes('127.0.0.1:19602')) directRemoteRequests.push(socket.url());
  });
  await mobile.route('https://127.0.0.1:19602/**', async (route) => {
    directRemoteRequests.push(route.request().url());
    await route.abort();
  });
  await mobile.goto(origin);
  await mobile.waitForFunction(() => (window as any).connectionCore);
  const pairing = await page.evaluate(() =>
    (window as any).connectionCore.api('/pairing/window', { remote: true }),
  );
  const mobileRequest = await mobile.evaluate(
    async ({ gateway, code }) =>
      (window as any).connectionCore.claim(
        gateway.uri,
        gateway.fingerprint,
        code,
        'Relay tablet',
        false,
      ),
    { gateway, code: pairing.code },
  );
  await page.evaluate(async () => {
    const client = (window as any).connectionCore;
    const pending = await client.api('/pairing/pending');
    await client.api('/pairing/approve', {
      id: pending.find((device: any) => device.name === 'Relay tablet').id,
      role: 'operator',
      approve: true,
    });
  });
  await mobile.evaluate(async (request) => {
    await (window as any).connectionCore.pollPair(request);
  }, mobileRequest);
  await expect
    .poll(() => mobile.evaluate(() => (window as any).connectionCore.state.online))
    .toBe(true);
  await page.getByRole('button', { name: '设备与连接', exact: true }).click();
  await expect(page.locator('.relay-panel')).toBeVisible();
  await page.getByRole('button', { name: '添加中转 Core', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const remoteWindow = await page.evaluate(
    async (remoteId) =>
      (window as any).connectionFleet
        .getSnapshot()
        .find((host: any) => host.id === remoteId)
        .client.api('/pairing/window', { remote: true }),
    remoteId,
  );
  await dialog.getByLabel('远端名称', { exact: true }).fill('家中主机');
  await dialog.getByLabel('远端 Core 地址', { exact: true }).fill(upstream.uri);
  await dialog.getByLabel('远端 SHA-256 指纹', { exact: true }).fill(upstream.fingerprint);
  await dialog.getByLabel('远端配对码', { exact: true }).fill(remoteWindow.code);
  await dialog.getByLabel('Relay tablet中转权限', { exact: true }).selectOption('operator');
  await dialog.getByRole('button', { name: '建立中转', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.relay-row')).toContainText('等待远端批准中转配对');
  await expect
    .poll(() =>
      page.evaluate(
        async (remoteId) =>
          (
            await (window as any).connectionFleet
              .getSnapshot()
              .find((host: any) => host.id === remoteId)
              .client.api('/pairing/pending')
          ).length,
        remoteId,
      ),
    )
    .toBe(1);
  await page.evaluate(
    async ({ remoteId, gatewayId }) => {
      const client = (window as any).connectionFleet
        .getSnapshot()
        .find((host: any) => host.id === remoteId).client;
      const pending = await client.api('/pairing/pending');
      const request = pending.find((item: any) => item.deviceId === 'relay-' + gatewayId);
      await client.api('/pairing/approve', { id: request.id, role: 'operator', approve: true });
    },
    { remoteId, gatewayId },
  );
  await expect
    .poll(
      () =>
        mobile.evaluate(
          () =>
            (window as any).connectionFleet.getSnapshot().filter((host: any) => host.state.online)
              .length,
        ),
      { timeout: 20000 },
    )
    .toBe(2);
  await expect(mobile.locator('.aggregate-host')).toHaveCount(2);
  await expect(mobile.locator('.aggregate-widget')).toHaveCount(0);
  await expect(mobile.locator(`[data-host-id="${remoteId}"]`)).toContainText('家中主机');
  await expect(mobile.locator(`[data-host-id="${remoteId}"] .host-metrics`)).toContainText('%');
  // A remembered direct address that is unusable on mobile must not suppress
  // its authorized relay or create a duplicate host in the overview.
  await mobile.evaluate(
    async ({ upstream, remoteId }) => {
      const client = (window as any).connectionCore;
      client.patch({
        knownEndpoints: [
          ...client.state.knownEndpoints,
          {
            uri: upstream.uri,
            publicKeyHash: upstream.fingerprint,
            serverId: remoteId,
            priority: 0,
          },
        ],
      });
      await (window as any).connectionFleet.refreshRelays();
    },
    { upstream, remoteId },
  );
  await expect(mobile.locator('.aggregate-host')).toHaveCount(2);
  expect(
    await mobile.evaluate(
      (id) =>
        Boolean(
          (window as any).connectionFleet.getSnapshot().find((host: any) => host.id === id).state
            .endpoint.relay,
        ),
      remoteId,
    ),
  ).toBe(true);
  await mobile.evaluate((id) => {
    const client = (window as any).connectionCore;
    client.patch({
      knownEndpoints: client.state.knownEndpoints.filter(
        (endpoint: any) => endpoint.serverId !== id,
      ),
    });
  }, remoteId);
  await expect
    .poll(() =>
      mobile.evaluate(
        (id) =>
          Object.keys(
            (window as any).connectionFleet.getSnapshot().find((host: any) => host.id === id).state
              .telemetry,
          ).length,
        remoteId,
      ),
    )
    .toBeGreaterThan(0);
  await mobile.screenshot({ path: 'artifacts/relay-overview-tablet-0.1.35.png', fullPage: true });
  await mobile
    .locator(`[data-host-id="${remoteId}"]`)
    .getByRole('button', { name: '打开工作区', exact: true })
    .click();
  await expect(mobile.locator('main h1')).toHaveText('远端工作区');
  await expect(mobile.locator('.workspace-core-switcher button')).toHaveCount(2);
  await expect(mobile.locator('.sidebar-host-group')).toHaveCount(2);
  await expect
    .poll(() =>
      mobile.evaluate(() => (window as any).connectionCore.state.endpoint.relay.gatewayId),
    )
    .toBe(gatewayId);
  await mobile.evaluate(async () => {
    const client = (window as any).connectionCore;
    const widget = client.state.snapshot.entities.find((entity: any) => entity.id === 'widget-cpu');
    await client.command(widget, 'widget.update', { title: '由平板修改的远端 CPU' });
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).connectionFleet
            .getSnapshot()
            .find((host: any) => host.id === id)
            .state.snapshot.entities.find((entity: any) => entity.id === 'widget-cpu').data.title,
        remoteId,
      ),
    )
    .toBe('由平板修改的远端 CPU');
  expect(
    await page.evaluate(
      () =>
        (window as any).connectionCore.state.snapshot.entities.find(
          (entity: any) => entity.id === 'widget-cpu',
        ).data.title,
    ),
  ).not.toBe('由平板修改的远端 CPU');
  await mobile.screenshot({ path: 'artifacts/relay-workspace-tablet-0.1.35.png', fullPage: true });
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.evaluate(() => scrollTo(0, 0));
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await mobile.screenshot({ path: 'artifacts/relay-workspace-mobile-0.1.35.png', fullPage: true });
  // Restrict the device without changing its existing local pairing or keys.
  await page.getByRole('button', { name: '设置家中主机中转', exact: true }).click();
  await page.getByLabel('Relay tablet中转权限', { exact: true }).selectOption('viewer');
  await page.getByRole('button', { name: '保存中转授权', exact: true }).click();
  await expect
    .poll(() => mobile.evaluate(() => (window as any).connectionCore.state.device?.role))
    .toBe('viewer');
  await expect(mobile.getByRole('button', { name: '编辑布局', exact: true })).toBeDisabled();
  await expect
    .poll(() => mobile.evaluate(() => (window as any).connectionCore.state.online))
    .toBe(true);
  const denied = await mobile.evaluate(async () => {
    const client = (window as any).connectionCore;
    try {
      await client.command(
        client.state.snapshot.entities.find((entity: any) => entity.id === 'widget-cpu'),
        'widget.update',
        { title: 'Must not happen' },
      );
      return 'allowed';
    } catch (e: any) {
      return e.code;
    }
  });
  expect(denied).toBe('FORBIDDEN');
  await page.getByRole('button', { name: '设置家中主机中转', exact: true }).click();
  await page.getByLabel('Relay tablet中转权限', { exact: true }).selectOption('');
  await page.getByRole('button', { name: '保存中转授权', exact: true }).click();
  await expect
    .poll(() => mobile.evaluate(() => (window as any).connectionCore.state.endpoint.serverId))
    .toBe(gatewayId);
  await expect
    .poll(() => mobile.evaluate(() => (window as any).connectionFleet.getSnapshot().length))
    .toBe(1);
  expect(directRemoteRequests).toEqual([]);
  expect(errors).toEqual([]);
  await mobileContext.close();
  // A revoked device disappears from the editor and does not prevent saving
  // the route for devices that remain paired.
  const revokedId = await page.evaluate(async () => {
    const client = (window as any).connectionCore;
    const route = (await client.api('/relays'))[0];
    const device = (await client.api('/devices')).find(
      (device: any) => device.name === 'Relay tablet',
    );
    await client.api('/relays', {
      uri: route.uri,
      fingerprint: route.fingerprint,
      name: route.name,
      code: '',
      grants: { ...route.grants, [device.id]: 'viewer' },
    });
    await client.api(`/devices/${device.id}/revoke`, {});
    return device.id;
  });
  await expect(page.locator('.relay-row')).toContainText('1 台设备获授权');
  await page.getByRole('button', { name: '设置家中主机中转', exact: true }).click();
  await expect(page.getByLabel('Relay tablet中转权限', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存中转授权', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(
      async (id) => (await (window as any).connectionCore.api('/relays'))[0].grants[id],
      revokedId,
    ),
  ).toBeUndefined();
});
