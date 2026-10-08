import { core } from '../../client/src/core';
// Isolated browser fixture, never connected to the installed Core or its device store.
const initialization = core.init();
core.init = () => initialization;
await initialization;
(window as any).connectionCore = core;
await import('../../client/src/main');
