import { useEffect, useState } from 'react';
import { MonitorDown, RefreshCw } from 'lucide-react';
import { Button } from './components';
import {
  desktopNative,
  desktopModeInfo,
  configureDesktopMode,
  enterBackgroundMode,
  type DesktopModePreferences,
} from './platform';

export function DesktopServicePanel() {
  if (!desktopNative) return null;
  return <DesktopServiceSettings />;
}

function DesktopServiceSettings() {
  const [preferences, setPreferences] = useState<DesktopModePreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void desktopModeInfo()
      .then((value) => {
        if (active) {
          setPreferences(value);
          setError('');
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const save = async (next: DesktopModePreferences) => {
    const previous = preferences;
    setPreferences(next);
    setBusy(true);
    setError('');
    try {
      setPreferences(await configureDesktopMode(next));
    } catch (failure) {
      setPreferences(previous);
      setError(`设置未保存，请重试：${String(failure)}`);
    } finally {
      setBusy(false);
    }
  };
  const background = async () => {
    setBusy(true);
    setError('');
    try {
      await enterBackgroundMode();
    } catch (failure) {
      setError(`切换失败，请重试：${String(failure)}`);
      setBusy(false);
    }
  };
  return (
    <section className="panel desktop-service" aria-labelledby="desktop-service-title">
      <div className="panel-title update-heading">
        <div>
          <h2 id="desktop-service-title">后台服务</h2>
          <p>关闭桌面界面，继续为已配对设备提供 Core 和插件服务</p>
        </div>
        <Button
          className="secondary"
          disabled={!preferences || busy}
          pending={busy}
          onClick={() => void background()}
        >
          <MonitorDown size={18} />
          切换为后台模式
        </Button>
      </div>
      <div className="desktop-service-options">
        {(
          [
            ['startInBackground', '启动时进入后台', '打开应用时只启动服务，需要界面时从托盘打开'],
            [
              'closeToBackground',
              '关闭窗口时转入后台',
              '点击窗口关闭按钮后保留服务，从托盘退出才会停止',
            ],
          ] as const
        ).map(([key, title, description]) => (
          <label className="desktop-service-option" key={key}>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <input
              type="checkbox"
              aria-label={title}
              checked={preferences?.[key] ?? false}
              disabled={!preferences || busy}
              onChange={(event) => {
                if (preferences) void save({ ...preferences, [key]: event.target.checked });
              }}
            />
          </label>
        ))}
      </div>
      <p className="panel-description">
        点击系统托盘图标或再次打开快捷方式可恢复界面，配对、布局和插件设置会保留
      </p>
      {error ? (
        <div className="desktop-service-error" role="alert">
          <span>{error}</span>
          {!preferences ? (
            <Button className="secondary" onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={18} />
              重新读取
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
