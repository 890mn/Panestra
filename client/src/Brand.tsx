import { version } from '../package.json';
import { Github } from 'lucide-react';
import { native, openProjectGitHub } from './platform';

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
  return (
    <>
      <a
        className="brand-link"
        href={PROJECT_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Panestra GitHub"
        onClick={(event) => {
          if (!native) return;
          event.preventDefault();
          void openProjectGitHub().catch((error) => onError?.(error));
        }}
      >
        <span className="brand-icon-wrap" aria-hidden="true">
          <img className="brand-icon" src="/icon.png" alt="" />
          <span className="github-badge">
            <Github size={10} />
          </span>
        </span>
        <span className="brand-copy">
          <span className="brand-name">Panestra</span>
          {slogan ? <small className="brand-slogan">{SLOGAN}</small> : null}
        </span>
      </a>
      {showVersion ? <span className="brand-version">v{version}</span> : null}
    </>
  );
}
