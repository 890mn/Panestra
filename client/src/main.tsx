import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readTheme, ThemeProvider } from './theme';
import { UranusBackdrop } from './Uranus23';
import './styles.css';
import './controls.css';
import './layout-editor.css';
import './widget-views.css';
import './plugins.css';
import './uranus23.css';
applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <UranusBackdrop />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
