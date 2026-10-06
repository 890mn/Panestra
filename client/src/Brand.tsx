import { version } from '../package.json';

export const SLOGAN = 'one core, every device.';

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
        <span className="brand-name">
          Panestra<span className="brand-divider">/</span>
          <span className="brand-chinese">星序</span>
        </span>
        {slogan ? <small className="brand-slogan">{SLOGAN}</small> : null}
      </span>
      {showVersion ? <span className="brand-version">v{version}</span> : null}
    </>
  );
}
