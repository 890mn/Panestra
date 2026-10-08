import { createRoot } from 'react-dom/client';
import '../../client/src/styles.css';
import '../../client/src/controls.css';
import '../../client/src/uranus23.css';
import { ThemeProvider } from '../../client/src/theme';

// This is a standalone browser fixture, not an installed native application.
if (new URLSearchParams(location.search).has('native')) {
  const { mockIPC } = await import('@tauri-apps/api/mocks');
  let preferences = { startInBackground: false, closeToBackground: false };
  mockIPC(async (command, args) => {
    (window as any).updateInvocations = [
      ...((window as any).updateInvocations || []),
      { command, version: args?.expectedVersion, preferences: args?.preferences },
    ];
    if (command === 'desktop_mode_info') return preferences;
    if (command === 'configure_desktop_mode') {
      if ((window as any).failDesktopSave) throw new Error('模拟写入失败');
      preferences = args?.preferences as typeof preferences;
      return preferences;
    }
    if (command === 'enter_background_mode') throw new Error('模拟切换失败');
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
const [{ AppUpdates }, { Brand }, { compareVersions }, { DesktopServicePanel }] = await Promise.all(
  [
    import('../../client/src/AppUpdates'),
    import('../../client/src/Brand'),
    import('../../client/src/app-updates'),
    import('../../client/src/DesktopServicePanel'),
  ],
);
(window as any).compareVersions = compareVersions;
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <main style={{ padding: 24 }}>
      <div className="brand">
        <Brand slogan showVersion />
      </div>
      <AppUpdates />
      {new URLSearchParams(location.search).has('service') ? <DesktopServicePanel /> : null}
    </main>
  </ThemeProvider>,
);
