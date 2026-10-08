import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

export type Theme = {
  mode: 'day' | 'night' | 'system';
  accent: string;
  experience: 'standard' | 'uranus23';
  unlocked: boolean;
};
const defaultTheme: Theme = {
  mode: 'day',
  accent: '#719b87',
  experience: 'standard',
  unlocked: false,
};
const storageKey = 'panestra.theme.v1';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const subscribe = (change: () => void) => {
  system.addEventListener('change', change);
  return () => system.removeEventListener('change', change);
};
const systemNight = () => system.matches;

export function readTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!saved || typeof saved !== 'object') return defaultTheme;
    const experience = saved.experience === 'uranus23' ? 'uranus23' : 'standard';
    return {
      mode: ['day', 'night', 'system'].includes(saved.mode) ? saved.mode : 'day',
      accent: /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : defaultTheme.accent,
      experience,
      unlocked: saved.unlocked === true || experience === 'uranus23',
    };
  } catch {
    return defaultTheme;
  }
}

export function applyTheme(theme: Theme, night = systemNight()) {
  const mode = theme.mode === 'system' ? (night ? 'night' : 'day') : theme.mode;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.experience = theme.experience;
  root.style.setProperty('--accent', theme.accent);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      theme.experience === 'uranus23'
        ? mode === 'night'
          ? '#080c10'
          : '#eef3f6'
        : mode === 'night'
          ? '#101113'
          : '#f6f7f8',
    );
}

type ThemeState = {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  resolved: 'day' | 'night';
  toggleTheme: () => void;
};
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(readTheme);
  const night = useSyncExternalStore(subscribe, systemNight);
  const resolved = theme.mode === 'system' ? (night ? 'night' : 'day') : theme.mode;
  useLayoutEffect(() => applyTheme(theme, night), [theme, night]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(theme));
    } catch {
      // Appearance remains usable when storage is unavailable.
    }
  }, [theme]);
  return (
    <ThemeContext
      value={{
        theme,
        setTheme,
        resolved,
        toggleTheme: () =>
          setTheme((current) => ({ ...current, mode: resolved === 'night' ? 'day' : 'night' })),
      }}
    >
      {children}
    </ThemeContext>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}
