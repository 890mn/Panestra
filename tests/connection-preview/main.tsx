import { core, coreFleet } from '../../client/src/core';
import { get } from 'idb-keyval';
// Isolated browser fixture, never connected to the installed Core or its device store.
const initialization = core.init();
core.init = () => initialization;
await initialization;
(window as any).connectionCore = core;
(window as any).connectionFleet = coreFleet;
(window as any).readActiveCore = () => get('panestra.active.v1');
await import('../../client/src/main');
