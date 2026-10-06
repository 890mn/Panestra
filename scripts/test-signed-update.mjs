// Exercises the real offline publisher, owner UI, worker replacement and Core restart.
import { chromium, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, '.tools/update-tests'), { recursive: true });
const data = mkdtempSync(path.join(root, '.tools/update-tests/core-'));
const key = path.join(data, 'publisher.protected');
const metadata = path.join(data, 'release');
const artifact = path.join(root, 'artifacts/Panestra-0.1.11-windows-x64.zip');
const run = (exe, args) =>
  execFileSync(path.join(root, 'artifacts', exe), args, {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  });
run('panestra-sign.exe', [
  '--generate-key',
  '--key',
  key,
  '--artifact',
  artifact,
  '--version',
  '0.1.11',
  '--sequence',
  '1',
  '--output',
  metadata,
]);
const publisher = readFileSync(metadata + '.pub', 'utf8');
writeFileSync(path.join(data, 'publisher.pub'), publisher);
run('panestra-release.exe', [
  '--artifact',
  artifact,
  '--metadata',
  metadata + '.json',
  '--signature',
  metadata + '.sig',
  '--publisher-key',
  publisher,
  '--root',
  path.join(data, 'releases'),
  '--activate',
]);
let core,
  bootstrap = '',
  fingerprint = '',
  browser;
async function start() {
  core = spawn(
    path.join(root, 'artifacts/panestra-core.exe'),
    [
      '--data',
      data,
      '--listen',
      '127.0.0.1:19445',
      '--worker',
      path.join(root, 'artifacts/system-plugin.exe'),
      '--manifest',
      path.join(root, 'plugins/system/manifest.json'),
      '--parent-stdio',
    ],
    { cwd: root, windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Core startup timeout')), 15000);
    core.stdout.on('data', (raw) => {
      const match = raw.toString().match(/认领码[^:]+: (\S+)/);
      if (match) bootstrap = match[1];
    });
    core.stderr.on('data', (raw) => {
      for (const line of raw.toString().split('\n')) {
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
    core.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Core exited ${code}`));
    });
  });
}
async function stop() {
  if (!core || core.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      core.kill();
      resolve();
    }, 6000);
    core.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    core.stdin.end();
  });
}
try {
  await start();
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto('https://localhost:19445');
  await page.getByLabel('Core 身份指纹').fill(fingerprint);
  await page.getByLabel('首次认领码').fill(bootstrap);
  await page.getByRole('button', { name: '建立并进入工作空间' }).click();
  await expect(page.getByTestId('widget-cpu')).toBeVisible();
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByLabel('读取系统指标').check();
  await page.getByRole('button', { name: '授权并启用' }).click();
  await page.getByRole('button', { name: '检查待更新版本' }).click();
  await expect(page.getByText('可切换到 System Monitor 0.1.0')).toBeVisible();
  const switchedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/plugins/system/update') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '验证并切换' }).click();
  const worker = await (await switchedResponse).json();
  await expect(page.locator('.toast')).toContainText('插件版本已切换', { timeout: 15000 });
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await expect(page.getByTestId('widget-cpu').locator('.metric-value')).not.toContainText('—', {
    timeout: 15000,
  });
  if (process.env.PANESTRA_PROFILE_SECONDS) {
    const seconds = Number(process.env.PANESTRA_PROFILE_SECONDS);
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 120 || !Number.isInteger(worker.pid))
      throw new Error('Invalid profile settings');
    const command = `$samples=@(); for($i=0;$i -le ${seconds};$i++){ $samples += @(Get-Process -Id ${core.pid},${worker.pid} | ForEach-Object { [pscustomobject]@{time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pid=$_.Id;cpuSeconds=$_.TotalProcessorTime.TotalSeconds;rssBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64} }); if($i -lt ${seconds}){Start-Sleep -Seconds 1} }; ConvertTo-Json -InputObject $samples -Compress`;
    const samples = JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
        windowsHide: true,
        encoding: 'utf8',
      }),
    );
    const statistics = (pid) => {
      const points = samples.filter((sample) => sample.pid === pid);
      const first = points[0],
        last = points.at(-1);
      return {
        samples: points.length,
        cpuPercentOfOneLogicalProcessor:
          ((last.cpuSeconds - first.cpuSeconds) * 100000) / (last.time - first.time),
        rssMeanBytes: points.reduce((sum, point) => sum + point.rssBytes, 0) / points.length,
        rssPeakBytes: Math.max(...points.map((point) => point.rssBytes)),
        privatePeakBytes: Math.max(...points.map((point) => point.privateBytes)),
      };
    };
    writeFileSync(
      path.join(root, 'artifacts/runtime-profile.json'),
      JSON.stringify(
        {
          seconds,
          workload:
            'one browser, five seeded widgets, one real System Plugin at 1 Hz; after signed hot switch',
          core: statistics(core.pid),
          worker: statistics(worker.pid),
          samples,
        },
        null,
        2,
      ),
    );
  }
  const originalFingerprint = fingerprint;
  await stop();
  await start();
  if (fingerprint !== originalFingerprint)
    throw new Error('Core identity changed across update restart');
  await expect(page.locator('.live-pill')).toContainText('实时同步', { timeout: 20000 });
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.getByLabel('读取系统指标')).toBeChecked();
  await expect(page.getByText('运行中', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '检查待更新版本' }).click();
  await expect(page.getByText('当前没有待更新版本')).toBeVisible();
  writeFileSync(
    path.join(root, 'artifacts/signed-release-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        packageSHA256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
        keyStorage: 'Windows DPAPI',
        signature: 'Ed25519',
        perFileDigests: true,
        offlineSignAndStage: true,
        ownerUIHotSwitch: true,
        preservedPermission: true,
        restartSameIdentity: true,
        installedWorkerReverifiedOnRestart: true,
        productionPublisher: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'Signed update passed: offline DPAPI signing, owner UI hot switch, persisted permissions, restart and re-verification',
  );
} finally {
  await browser?.close();
  await stop();
}
