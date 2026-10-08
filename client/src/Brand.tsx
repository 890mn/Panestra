import { version } from '../package.json';
import { useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Github, History, Monitor, Smartphone } from 'lucide-react';
import { native, openProjectGitHub } from './platform';
import { Button, Modal } from './components';
import { ReleaseNotes } from './ReleaseNotes';
import { useTheme } from './theme';
import { UranusPortal } from './Uranus23';

export const SLOGAN = 'ONE CORE, EVERY DEVICE.';
export const PROJECT_URL = 'https://github.com/890mn/Panestra';

export function Brand({
  slogan = false,
  showVersion = false,
  onError,
}: {
  slogan?: boolean;
  showVersion?: boolean;
  onError?: (error: unknown) => void;
}) {
  const [view, setView] = useState<'about' | 'logs' | 'uranus23' | null>(null);
  const { theme, setTheme } = useTheme();
  const taps = useRef({ count: 0, time: 0 });
  const [hint, setHint] = useState('');
  const discover = () => {
    const now = Date.now();
    taps.current = {
      count: now - taps.current.time < 4000 ? taps.current.count + 1 : 1,
      time: now,
    };
    if (theme.unlocked || taps.current.count >= 7) {
      setTheme((current) => ({ ...current, unlocked: true }));
      taps.current.count = 0;
      setHint('');
      setView('uranus23');
    } else if (taps.current.count >= 3) {
      setHint(`再轻触 ${7 - taps.current.count} 次，看看星环的另一边`);
    }
  };
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const openGitHub = async () => {
    setOpening(true);
    setError('');
    try {
      if (native) await openProjectGitHub();
      else window.open(PROJECT_URL, '_blank', 'noopener,noreferrer');
    } catch (failure) {
      setError('无法打开浏览器，请稍后重试');
      onError?.(failure);
    } finally {
      setOpening(false);
    }
  };
  return (
    <>
      <Button
        className="brand-link"
        aria-label="关于 Panestra"
        aria-haspopup="dialog"
        onClick={() => {
          setError('');
          setHint('');
          taps.current.count = 0;
          setView('about');
        }}
      >
        <span className="brand-icon-wrap" aria-hidden="true">
          <img className="brand-icon" src="/icon.png" alt="" />
        </span>
        <span className="brand-copy">
          <span className="brand-name">Panestra</span>
          {slogan ? <small className="brand-slogan">{SLOGAN}</small> : null}
        </span>
      </Button>
      {showVersion ? <span className="brand-version">v{version}</span> : null}
      {view ? (
        <Modal
          title={
            view === 'uranus23' ? '天王星 23°' : view === 'about' ? '关于 Panestra' : '更新日志'
          }
          close={() => setView(null)}
          wide
        >
          {view === 'uranus23' ? (
            <UranusPortal close={() => setView(null)} />
          ) : view === 'logs' ? (
            <>
              <Button className="secondary" onClick={() => setView('about')}>
                <ArrowLeft size={18} />
                返回关于
              </Button>
              <ReleaseNotes />
            </>
          ) : (
            <div className="about-content">
              <div className="about-identity">
                <img src="/icon.png" alt="" />
                <div>
                  <h3>
                    Panestra <span>星序</span>
                  </h3>
                  <p>{SLOGAN}</p>
                </div>
                <Button
                  className="about-version mono"
                  aria-label={`版本 v${version}`}
                  title="这里藏着一点偏航"
                  onClick={discover}
                >
                  v{version}
                </Button>
              </div>
              {hint ? (
                <p className="uranus-discovery-hint" role="status">
                  {hint}
                </p>
              ) : null}
              <p className="about-description">
                让 Windows 电脑成为核心，在手机和平板上查看状态、调整布局与操作组件
              </p>
              <div className="about-platforms">
                <span>
                  <Monitor size={16} />
                  Windows Core
                </span>
                <span>
                  <Smartphone size={16} />
                  Android Surface
                </span>
              </div>
              <dl className="about-features">
                <div>
                  <dt>状态与控制</dt>
                  <dd>系统指标、Codex 额度和组件操作集中在一个界面</dd>
                </div>
                <div>
                  <dt>自由布局</dt>
                  <dd>实时预览、拖动与尺寸预设，让不同屏幕各有安排</dd>
                </div>
                <div>
                  <dt>本地优先</dt>
                  <dd>配置保存在本地，设备配对后通过局域网同步</dd>
                </div>
              </dl>
              <div className="about-actions">
                {theme.unlocked ? (
                  <Button className="secondary" onClick={() => setView('uranus23')}>
                    天王星 23°
                  </Button>
                ) : null}
                <Button className="primary" pending={opening} onClick={() => void openGitHub()}>
                  <Github size={18} />
                  GitHub 项目
                  <ExternalLink size={16} />
                </Button>
                <Button className="secondary" onClick={() => setView('logs')}>
                  <History size={18} />
                  更新日志
                </Button>
              </div>
              {error ? (
                <p className="about-error" role="alert">
                  {error}
                </p>
              ) : null}
              <p className="about-hint">源码、问题反馈与正式版本均在 GitHub 项目中提供</p>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}
