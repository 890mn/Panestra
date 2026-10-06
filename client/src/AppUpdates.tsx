import { useEffect, useRef, useState } from 'react';
import { Download, History, RefreshCw } from 'lucide-react';
import { version } from '../package.json';
import { ReleaseNotes } from './ReleaseNotes';
import { Button, Modal } from './components';
import { checkAppUpdate, installAppUpdate, type AppRelease } from './app-updates';

export function AppUpdates() {
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [message, setMessage] = useState('从 GitHub Releases 获取正式版本');
  const [failure, setFailure] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [logs, setLogs] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = async () => {
    setBusy('check');
    setFailure(false);
    setRelease(null);
    try {
      const result = await checkAppUpdate();
      if (!mounted.current) return;
      setRelease(result);
      setMessage(result?.message || '暂无发布版本');
    } catch (error) {
      if (!mounted.current) return;
      setFailure(true);
      setMessage(
        error instanceof Error && error.name !== 'TimeoutError'
          ? error.message
          : '检查更新超时，请稍后重试',
      );
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const install = async () => {
    if (!release?.available || !release.installable) return;
    setBusy('install');
    setFailure(false);
    setPercent(null);
    setMessage('正在下载并校验更新');
    try {
      await installAppUpdate(release.version, (value) => {
        if (mounted.current) setPercent(value);
      });
      if (mounted.current)
        setMessage(
          /Android/i.test(navigator.userAgent)
            ? '请在系统窗口确认安装，完成后重新打开 Panestra'
            : '更新正在安装，完成后将重新打开 Panestra',
        );
    } catch (error) {
      if (mounted.current) {
        setFailure(true);
        setMessage(String(error instanceof Error ? error.message : error));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <>
      <section className="panel app-updates" aria-labelledby="app-updates-title">
        <div className="panel-title update-heading">
          <div>
            <h2 id="app-updates-title">应用更新</h2>
            <p>
              当前版本 <span className="mono">v{version}</span>
            </p>
          </div>
          <div className="update-actions">
            <Button
              className="secondary"
              pending={busy === 'check'}
              disabled={!!busy}
              onClick={() => void check()}
            >
              <RefreshCw size={18} />
              {busy === 'check' ? '正在检查' : '检查更新'}
            </Button>
            <Button
              className="secondary"
              disabled={busy === 'install'}
              onClick={() => {
                setLogs(true);
              }}
            >
              <History size={18} />
              更新日志
            </Button>
          </div>
        </div>
        <div className="update-status" role="status" data-error={failure || undefined}>
          <span>{message}</span>
          {release?.available ? <span className="mono">v{release.version}</span> : null}
          {busy === 'install' ? (
            <progress aria-label="更新下载进度" max={100} value={percent ?? undefined} />
          ) : null}
        </div>
        {release?.available ? (
          <div className="update-install-row">
            <p>
              {/Android/i.test(navigator.userAgent)
                ? '安装由 Android 系统确认，配对和布局会保留'
                : '安装时会短暂断开 Core，完成后自动重启，配对和布局会保留'}
            </p>
            <Button
              className="primary"
              disabled={!release.installable || !!busy}
              pending={busy === 'install'}
              onClick={() => void install()}
            >
              <Download size={18} />
              {busy === 'install' ? '正在更新' : '下载并更新'}
            </Button>
          </div>
        ) : null}
      </section>
      {logs ? (
        <Modal title="更新日志" close={() => setLogs(false)} wide>
          <ReleaseNotes release={release} />
        </Modal>
      ) : null}
    </>
  );
}
