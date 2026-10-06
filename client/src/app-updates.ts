import { version } from '../package.json';
import { native } from './platform';

export const RELEASE_API = 'https://api.github.com/repos/890mn/Panestra/releases/latest';
export interface AppRelease {
  version: string;
  notes: string;
  date: string;
  available: boolean;
  installable: boolean;
  message: string;
}
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error('发布版本格式不正确');
    const parts = value.replace(/^v/, '').split('.').map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('发布版本格式不正确');
    return parts;
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export async function checkAppUpdate(): Promise<AppRelease | null> {
  let response: Response;
  try {
    response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('无法检查更新，请检查网络后重试');
  }
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429)
    throw new Error('GitHub 请求暂时受限，请稍后重试');
  if (!response.ok) throw new Error('无法检查更新，请检查网络后重试');
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('发布信息过大');
  const release = JSON.parse(text);
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets))
    throw new Error('发布信息格式不正确');
  if (release.draft || release.prerelease) throw new Error('当前没有正式发布版本');
  const newer = compareVersions(release.tag_name, version) > 0;
  const assets: Array<{ name: string; browser_download_url: string; digest?: string }> =
    release.assets || [];
  const android = /Android/i.test(navigator.userAgent);
  const target = android
    ? `Panestra-${release.tag_name.replace(/^v/, '')}-android-arm64.apk`
    : 'latest.json';
  const asset = assets.find((item) => item.name === target);
  const valid =
    asset?.browser_download_url.startsWith(
      'https://github.com/890mn/Panestra/releases/download/',
    ) &&
    (!android || /^sha256:[a-f0-9]{64}$/.test(asset.digest || ''));
  const installable = native && !!valid;
  return {
    version: release.tag_name.replace(/^v/, ''),
    notes: typeof release.body === 'string' ? release.body : '',
    date: typeof release.published_at === 'string' ? release.published_at : '',
    available: newer,
    installable,
    message: newer
      ? installable
        ? '新版本已准备好'
        : native
          ? '此平台的更新包尚未发布'
          : '请在 Windows 或 Android 应用中安装更新'
      : '已是最新版本',
  };
}
export async function installAppUpdate(
  expectedVersion: string,
  progress: (value: number | null) => void,
): Promise<void> {
  if (!native) throw new Error('请在原生应用中安装更新');
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  if (/Android/i.test(navigator.userAgent)) {
    const onProgress = (event: Event) =>
      progress((event as CustomEvent<{ percent: number }>).detail.percent);
    window.addEventListener('panestra:update-progress', onProgress);
    try {
      await invoke('plugin:panestra-bridge|install_app_update', { expectedVersion });
    } finally {
      window.removeEventListener('panestra:update-progress', onProgress);
    }
  } else {
    const channel = new Channel<number | null>();
    channel.onmessage = progress;
    await invoke('install_app_update', { expectedVersion, progress: channel });
  }
}
