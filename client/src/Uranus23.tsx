import { useState } from 'react';
import { ArrowUpRight, Check, Moon, Sun } from 'lucide-react';
import { Button, Modal } from './components';
import { useTheme } from './theme';

export function UranusBackdrop() {
  const { theme } = useTheme();
  return theme.experience === 'uranus23' ? (
    <div className="uranus-backdrop" aria-hidden="true" />
  ) : null;
}

export function UranusPortal({ close }: { close: () => void }) {
  const { theme, setTheme, resolved } = useTheme();
  const [scene, setScene] = useState<'day' | 'night'>(resolved);
  const active = theme.experience === 'uranus23';
  return (
    <div className="uranus-portal">
      <div
        className={`uranus-landscape ${scene}`}
        role="img"
        aria-label={
          scene === 'day' ? '冰白天光下的冰原与天王星星环' : '深空银河下的冰原与天王星星环'
        }
      >
        <span className="uranus-coordinate" aria-hidden="true">
          23°
        </span>
        <span className="uranus-landscape-caption">
          URANUS / {scene === 'day' ? 'DAYLIGHT' : 'NIGHTFALL'}
        </span>
      </div>
      <div className="uranus-portal-copy">
        <span className="uranus-eyebrow">PANESTRA · HIDDEN EDITION</span>
        <h3>在 23°，换一片天空。</h3>
        <p>
          同一片冰原，两种光线
          <br />
          白昼留住天光，黑夜让银河浮现
        </p>
      </div>
      <div className="uranus-scene-switch" role="group" aria-label="观景光线">
        <Button className="secondary" selected={scene === 'day'} onClick={() => setScene('day')}>
          <Sun size={18} />
          冰昼
        </Button>
        <Button
          className="secondary"
          selected={scene === 'night'}
          onClick={() => setScene('night')}
        >
          <Moon size={18} />
          永夜
        </Button>
      </div>
      <div className="uranus-portal-actions">
        <Button
          className="primary"
          onClick={() => {
            setTheme((current) => ({
              ...current,
              unlocked: true,
              experience: 'uranus23',
              mode: scene,
            }));
            close();
          }}
        >
          <ArrowUpRight size={18} />
          {active ? '使用这片天空' : '开启天王星 23°'}
        </Button>
        {active ? (
          <Button
            className="secondary"
            onClick={() => {
              setTheme((current) => ({ ...current, experience: 'standard' }));
              close();
            }}
          >
            回到普通外观
          </Button>
        ) : null}
      </div>
      <p className="uranus-portal-note">
        开启后，白昼与黑夜会换成「冰昼」与「永夜」
        <br />
        在设置中可跟随系统，也可随时回到普通外观
      </p>
    </div>
  );
}

export function UranusHorizon() {
  const { theme, resolved } = useTheme();
  const [view, setView] = useState(false);
  if (theme.experience !== 'uranus23') return null;
  return (
    <>
      <section className="uranus-horizon" aria-label="天王星 23°">
        <div className="uranus-horizon-copy">
          <span className="uranus-eyebrow">PANESTRA / URANUS 23°</span>
          <h2>
            {resolved === 'day' ? '冰昼' : '永夜'}
            <span> / {resolved === 'day' ? 'DAYLIGHT' : 'NIGHTFALL'}</span>
          </h2>
          <p>{resolved === 'day' ? '天光落在冰原上' : '把夜色留给银河'}</p>
        </div>
        <Button className="secondary uranus-view-button" onClick={() => setView(true)}>
          观景
          <ArrowUpRight size={18} />
        </Button>
      </section>
      {view ? (
        <Modal title="天王星 23°" close={() => setView(false)} wide>
          <UranusPortal close={() => setView(false)} />
        </Modal>
      ) : null}
    </>
  );
}

export function UranusSettings() {
  const { theme, setTheme } = useTheme();
  if (!theme.unlocked) return null;
  const active = theme.experience === 'uranus23';
  return (
    <div className="uranus-settings">
      <span className="uranus-orbit-mark" aria-hidden="true">
        <i />
      </span>
      <div>
        <h3>天王星 23°</h3>
        <p>{active ? '冰昼与永夜已接管此设备的外观' : '你发现的天空，随时可以再回来'}</p>
      </div>
      <Button
        className="secondary"
        selected={active}
        onClick={() =>
          setTheme((current) => ({ ...current, experience: active ? 'standard' : 'uranus23' }))
        }
      >
        {active ? <Check size={18} /> : <ArrowUpRight size={18} />}
        {active ? '退出彩蛋模式' : '开启彩蛋模式'}
      </Button>
    </div>
  );
}
