// Screen capture only produces a frame when something on screen changes. A viewer
// who joins while the screen is still needs a keyframe, and the encoder can only
// make one from a new frame, so without this they see black until something moves.
// This re-sends the last frame whenever the capture has been quiet for a while.

//
// It also trims every frame to a size divisible by 8, at most 7 pixels. Hardware H.264
// encoders only take even sizes, and a window can be any size. With that, the stream's
// smaller layer can be exactly half or a quarter of it, which keeps it even too.

const MIN_FPS = 5;
const ALIGN = 8;

/** The frame's visible area, trimmed at the right and bottom to a multiple of ALIGN. */
function alignedRect(frame) {
  const rect = frame.visibleRect;
  const width = Math.max(ALIGN, rect.width - (rect.width % ALIGN));
  const height = Math.max(ALIGN, rect.height - (rect.height % ALIGN));
  return { x: rect.x, y: rect.y, width, height };
}

let alignFailed = false;

function align(frame) {
  if (alignFailed) return frame;
  try {
    const rect = alignedRect(frame);
    if (rect.width === frame.visibleRect.width && rect.height === frame.visibleRect.height) return frame;
    // A crop only changes the frame's metadata, the pixels aren't copied.
    const cropped = new VideoFrame(frame, { visibleRect: rect, displayWidth: rect.width, displayHeight: rect.height });
    frame.close();
    return cropped;
  } catch (error) {
    // Never let this stop a stream: send the frames as they are.
    alignFailed = true;
    console.log("[BYO Stream]", `couldn't trim frames to an even size, sending them as they are: ${error.message}`);
    return frame;
  }
}

/**
 * Wraps a capture track. Returns a track to publish instead; stopping it stops the
 * capture, and it fires "ended" when the capture ends. Its frameSize property is a
 * promise of the first frame's size, as published.
 */
export function keepAlive(track) {
  if (typeof MediaStreamTrackProcessor !== "function" || typeof MediaStreamTrackGenerator !== "function") {
    const { width, height } = track.getSettings();
    track.frameSize = Promise.resolve(width && height ? { width, height } : null);
    return track;
  }

  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  let last = null;
  let lastAt = 0;
  let finished = false;
  let reportSize;
  generator.frameSize = new Promise((resolve) => { reportSize = resolve; });

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
        const { value: raw, done } = await reader.read();
        if (done) break;
        const frame = align(raw);
        reportSize({ width: frame.displayWidth, height: frame.displayHeight });
        last?.close();
        last = frame.clone();
        lastAt = performance.now();
        await writer.write(frame);
      }
    } catch {
      // The capture or the published track went away.
    }
    reportSize(null);
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
