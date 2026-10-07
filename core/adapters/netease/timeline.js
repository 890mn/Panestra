// Fixed player operations only; no account, credentials, queue or arbitrary actions
async function panestraTimeline(request) {
  if (
    typeof webpackJsonp !== 'object' ||
    typeof legacyNativeCmder?.appendRegisterCall !== 'function'
  )
    throw new Error('unsupported');
  if (!window.__panestraTimelineRequire) {
    webpackJsonp.push([
      [987662],
      {
        987662: function (module, exports, require) {
          window.__panestraTimelineRequire = require;
        },
      },
      [[987662]],
    ]);
  }
  const require = window.__panestraTimelineRequire;
  let bridge = window.__panestraTimelineBridge;
  if (!bridge || bridge.version !== 2) {
    let tool;
    for (const [id, factory] of Object.entries(require.m || {})) {
      const source = String(factory);
      if (!source.includes('getStore(){') || !source.includes('getDispatch(){')) continue;
      const exports = require(id);
      tool = Object.values(exports).find(
        (value) =>
          typeof value?.getStore === 'function' &&
          typeof value?.getDispatch === 'function' &&
          value.inited,
      );
      if (tool) break;
    }
    const supportsSeek = Object.values(require.m || {}).some((factory) => {
      const source = String(factory);
      return source.includes('setPlayingPosition(') && source.includes('AudioPlayer.seek');
    });
    if (!tool || !supportsSeek) throw new Error('unsupported');
    bridge = { tool, event: null, version: 2 };
    legacyNativeCmder.appendRegisterCall('PlayProgress', 'audioplayer', (playId, position) => {
      if (typeof playId === 'string' && Number.isFinite(position))
        bridge.event = { playId, position, at: Date.now() };
    });
    legacyNativeCmder.appendRegisterCall(
      'Seek',
      'audioplayer',
      (playId, seekId, code, position) => {
        if (code === 0 && typeof playId === 'string' && Number.isFinite(position))
          bridge.event = { playId, position, at: Date.now() };
      },
    );
    window.__panestraTimelineBridge = bridge;
  }
  const snapshot = () => {
    const playing = bridge.tool.getStore().playing;
    if (
      !playing ||
      playing.isPlayingVideo ||
      !playing.resourceTrackId ||
      playing.resourceName !== request.title
    )
      throw new Error('changed');
    const duration = playing.resourceDuration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 604800)
      throw new Error('no timeline');
    const sliders = Array.from(
      document.querySelectorAll('input[type="range"][aria-orientation="horizontal"]'),
    ).filter((el) => Number(el.min) === 0 && Math.abs(Number(el.max) - duration) < 0.01);
    const event = bridge.event;
    let position =
      event?.playId === playing.playId &&
      (playing.playingState !== 2 || Date.now() - event.at < 4000)
        ? event.position
        : null;
    if (position == null && playing.playingState !== 2 && sliders.length === 1)
      position = Number(sliders[0].value);
    if (!Number.isFinite(position) || position < 0 || position > duration)
      throw new Error('no position');
    return {
      title: playing.resourceName,
      trackId: `${playing.resourceTrackId}|${playing.playId || 'restore'}`,
      positionSeconds: position,
      durationSeconds: duration,
      seek: !playing.isLoadingFirst,
    };
  };
  if (!bridge.event && bridge.tool.getStore().playing.playingState === 2) {
    const deadline = Date.now() + 1600;
    while (!bridge.event && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const before = snapshot();
  if (request.action === 'read') return before;
  if (
    request.action !== 'seek' ||
    !before.seek ||
    request.trackId !== before.trackId ||
    !Number.isFinite(request.positionSeconds) ||
    request.positionSeconds < 0 ||
    request.positionSeconds > before.durationSeconds
  )
    throw new Error('invalid seek');
  const playing = bridge.tool.getStore().playing;
  let failed = false;
  const operation = playing.restoreResource
    ? bridge.tool.getDispatch()({
        type: 'playing/setPlayingPosition',
        payload: { duration: request.positionSeconds },
      })
    : legacyNativeCmder.call(
        'audioplayer.seek',
        playing.playId,
        `panestra|seek|${Date.now()}`,
        request.positionSeconds,
      );
  Promise.resolve(operation).catch(() => {
    failed = true;
  });
  const started = Date.now();
  while (Date.now() - started < 2500) {
    if (failed) throw new Error('seek rejected');
    const after = snapshot();
    if (after.trackId !== before.trackId) throw new Error('changed');
    if (Math.abs(after.positionSeconds - request.positionSeconds) < 2) return after;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('seek unconfirmed');
}
