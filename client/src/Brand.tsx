import { version } from '../package.json';
import { useState } from 'react';
import { ArrowLeft, ExternalLink, Github, History, Monitor, Smartphone } from 'lucide-react';
import { native, openProjectGitHub } from './platform';
import { Button, Modal } from './components';
import { ReleaseNotes } from './ReleaseNotes';

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
  const [view, setView] = useState<'about' | 'logs' | null>(null);
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
          title={view === 'about' ? '关于 Panestra' : '更新日志'}
          close={() => setView(null)}
          wide
        >
          {view === 'logs' ? (
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
                <span className="about-version mono">v{version}</span>
              </div>
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
