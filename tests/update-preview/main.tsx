import { createRoot } from 'react-dom/client';
import '../../client/src/styles.css';
import '../../client/src/controls.css';

// This is a standalone browser fixture, not an installed native application.
if (new URLSearchParams(location.search).has('native')) {
  const { mockIPC } = await import('@tauri-apps/api/mocks');
  mockIPC(async (command, args) => {
    (window as any).updateInvocations = [
      ...((window as any).updateInvocations || []),
      { command, version: args?.expectedVersion },
    ];
    if (command === 'install_app_update') {
      (args?.progress as any).onmessage(45);
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error('更新下载或签名校验失败，当前版本未更改');
    }
    if (command === 'plugin:panestra-bridge|install_app_update') {
      window.dispatchEvent(
        new CustomEvent('panestra:update-progress', { detail: { percent: 60 } }),
      );
      return {};
    }
    return {};
  });
}
const [{ AppUpdates }, { Brand }, { compareVersions }] = await Promise.all([
  import('../../client/src/AppUpdates'),
  import('../../client/src/Brand'),
  import('../../client/src/app-updates'),
]);
(window as any).compareVersions = compareVersions;
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24 }}>
    <div className="brand">
      <Brand slogan showVersion />
    </div>
    <AppUpdates />
  </main>,
);
