// Screen capture only produces a frame when something on screen changes. A viewer
// who joins while the screen is still needs a keyframe, and the encoder can only
// make one from a new frame, so without this they see black until something moves.
// This re-sends the last frame whenever the capture has been quiet for a while.

const MIN_FPS = 5;

/**
 * Wraps a capture track. Returns a track to publish instead; stopping it stops the
 * capture, and it fires "ended" when the capture ends.
 */
export function keepAlive(track) {
  if (typeof MediaStreamTrackProcessor !== "function" || typeof MediaStreamTrackGenerator !== "function") return track;

  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  let last = null;
  let lastAt = 0;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    last?.close();
    last = null;
    reader.cancel().catch(() => {});
    writer.close().catch(() => {});
    track.stop();
  };

  const timer = setInterval(() => {
    if (!last || finished || performance.now() - lastAt < 1000 / MIN_FPS) return;
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    const elapsedUs = Math.round((performance.now() - lastAt) * 1000);
    const repeat = new VideoFrame(last, { timestamp: last.timestamp + elapsedUs });
    writer.write(repeat).catch(() => repeat.close());
  }, 1000 / MIN_FPS);

  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        last?.close();
        last = frame.clone();
        lastAt = performance.now();
        await writer.write(frame);
      }
    } catch {
      // The capture or the published track went away.
    }
    const endedBySource = !finished;
    finish();
    if (endedBySource) generator.dispatchEvent(new Event("ended"));
  })();

  const stop = generator.stop.bind(generator);
  generator.stop = () => {
    finish();
    stop();
  };
  return generator;
}
