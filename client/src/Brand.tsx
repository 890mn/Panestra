import { version } from '../package.json';
import { Github } from 'lucide-react';
import { native, openProjectGitHub } from './platform';

export const SLOGAN = 'ONE CORE, EVERY DEVICE.';
export const PROJECT_URL = 'https://github.com/890mn/Panestra';

export function Brand({
  slogan = false,
  showVersion = false,
}: {
  slogan?: boolean;
  showVersion?: boolean;
}) {
  return (
    <>
      <img className="brand-icon" src="/icon.png" alt="" />
      <span className="brand-copy">
        <span className="brand-name">Panestra</span>
        {slogan ? <small className="brand-slogan">{SLOGAN}</small> : null}
      </span>
      {showVersion ? <span className="brand-version">v{version}</span> : null}
    </>
  );
}

export function ProjectLink({ onError }: { onError: (error: unknown) => void }) {
  return (
    <a
      className="nav-item help project-link"
      href={PROJECT_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="在浏览器打开 GitHub 项目"
      onClick={(event) => {
        if (!native) return;
        event.preventDefault();
        void openProjectGitHub().catch(onError);
      }}
    >
      <span className="project-icon" aria-hidden="true">
        <img src="/icon.png" alt="" />
        <span className="github-badge">
          <Github size={10} />
        </span>
      </span>
      <span>关于 Panestra</span>
      <span className="version">v{version}</span>
    </a>
  );
}
