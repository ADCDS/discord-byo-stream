// Everything that touches Discord or the desktop capture APIs.
import { keepAlive } from "./keepalive.js";

function webpackRuntimes() {
  const chunks = window.webpackChunkdiscord_app;
  if (!Array.isArray(chunks)) return [];
  // Several webpack runtimes share this array and each one runs the callback.
  // Only one holds Discord's stores, and it isn't the last to run.
  const runtimes = [];
  chunks.push([[Symbol()], {}, (runtime) => { runtimes.push(runtime); }]);
  chunks.pop();
  return runtimes;
}

/** First webpack export the predicate accepts. Exports can throw on access, and some are proxies. */
export function findExport(predicate) {
  const accepts = (value) => {
    try {
      return Boolean(value) && predicate(value);
    } catch {
      return false;
    }
  };
  for (const runtime of webpackRuntimes()) {
    for (const mod of Object.values(runtime.c ?? {})) {
      const exports = mod?.exports;
      if (!exports) continue;
      if (accepts(exports)) return exports;
      if (typeof exports !== "object") continue;
      for (const key of Object.keys(exports)) {
        let value;
        try {
          value = exports[key];
        } catch {
          continue;
        }
        if (accepts(value)) return value;
      }
    }
  }
  return null;
}

// _dispatchToken marks a Flux store. Discord's intl proxy answers to any name, so the
// getName comparison has to be exact.
const findStoreViaWebpack = (name) => findExport((v) => v._dispatchToken && v.getName?.() === name);

const storeCache = new Map();

export function getStore(name) {
  if (storeCache.has(name)) return storeCache.get(name);
  const store = findStoreViaWebpack(name);
  if (store) storeCache.set(name, store);
  return store;
}

/** Throws if the store is missing, so that isn't mistaken for "not in a voice channel". */
export function getVoiceChannelId() {
  const store = getStore("SelectedChannelStore");
  if (!store) throw new Error("Discord's SelectedChannelStore was not found");
  return store.getVoiceChannelId() ?? null;
}

export function getUserId() {
  return getStore("UserStore")?.getCurrentUser?.()?.id ?? "";
}

export function getDisplayName() {
  const user = getStore("UserStore")?.getCurrentUser?.();
  return user?.globalName || user?.username || "";
}

export function listSources() {
  return window.DiscordNative.desktopCapture.getDesktopCaptureSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
  });
}

/**
 * Discord sets no display-media handler, so getDisplayMedia is unavailable and
 * this uses Electron's chromeMediaSource constraints instead. Audio and video go
 * in one request: on Wayland every desktop capture request opens its own portal
 * dialog. The source id goes on the video only, since on the audio it narrows or
 * breaks capture on some platforms.
 */
/**
 * Why system audio can't be shared here, or null if it can. Linux and Windows capture
 * the whole system output, which includes the voice call itself, so friends would
 * hear themselves. Discord avoids that by capturing one app with its native engine.
 */
export function systemAudioBlocker() {
  if (navigator.platform.startsWith("Mac") && !window.__vcstreamSystemAudio) return "macOS system audio needs the installer";
  if (navigator.platform.startsWith("Linux") && !hostAvailable()) return "system audio would include the voice call";
  return null;
}

// The Linux audio helper runs outside the page: in the Flatpak loader, reached through
// a debug-protocol binding, or in the installer's hook, which watches console messages.
const HOST_PREFIX = "[VCStream-host] ";

function hostAvailable() {
  return typeof window.vcstreamHost === "function" || window.__vcstreamConsoleHost === true;
}

function sendToHost(json) {
  if (typeof window.vcstreamHost === "function") window.vcstreamHost(json);
  else console.debug(HOST_PREFIX + json);
}

// ---- Linux: per-app audio through the loader's PipeWire helper ----

let nextHostCall = 0;
const hostReplies = new Map();
window.__vcstreamHostReply = (id, json) => {
  hostReplies.get(id)?.(JSON.parse(json));
  hostReplies.delete(id);
};

function hostCall(action, data = {}) {
  return new Promise((resolve) => {
    const id = ++nextHostCall;
    hostReplies.set(id, resolve);
    sendToHost(JSON.stringify({ id, action, ...data }));
    setTimeout(() => {
      if (hostReplies.delete(id)) resolve({ ok: false, error: "audio helper didn't answer" });
    }, 10_000);
  });
}

/** The apps matching the shared source, recorded from a private PipeWire sink. */
async function linuxAppAudio({ sourceId, sourceName }) {
  const kind = String(sourceId).startsWith("window:") ? "window" : "screen";
  const started = await hostCall("audio-start", { kind, title: sourceName ?? "" });
  if (!started.ok) return { audio: null, audioError: started.error };
  const cleanup = () => hostCall("audio-stop");
  const findDevice = async () =>
    (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label.includes(started.device));
  try {
    let device = await findDevice();
    if (!device) {
      // Device labels can stay hidden until the page has opened any audio input once.
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
      device = await findDevice();
    }
    if (!device) throw new Error(`${started.device} audio device isn't visible`);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    return { audio: stream.getAudioTracks()[0], audioError: null, audioApps: started.apps, cleanup };
  } catch (error) {
    cleanup();
    return { audio: null, audioError: `${error.name}: ${error.message}` };
  }
}

export async function capture(options) {
  const captured = await captureRaw(options);
  return { ...captured, video: keepAlive(captured.video) };
}

// macOS holds the request while its "record audio" prompt waits for a click, and
// nobody may be there to answer it. Chromium itself waits up to 59 s, and giving up
// earlier can leave CoreAudio stuck until Discord restarts, so wait a bit longer.
const SYSTEM_AUDIO_TIMEOUT_MS = 65_000;

/**
 * macOS and Windows: system audio without this app's own sound, through the installer's
 * display-media handler. Throws if that path isn't available or fails.
 */
async function captureWithSystemAudio({ sourceId, width, height, fps }) {
  window.__vcstreamDisplayRequest = { sourceId, audio: true };
  let timer;
  let gaveUp = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      reject(new Error("no answer to the system audio permission prompt"));
    }, SYSTEM_AUDIO_TIMEOUT_MS);
  });
  try {
    const request = navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: width }, height: { max: height }, frameRate: { max: fps } },
      audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
    });
    // If it's answered after we gave up, that capture must not keep running.
    request.then((late) => gaveUp && late.getTracks().forEach((track) => track.stop()), () => {});
    const stream = await Promise.race([request, timeout]);
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] ?? null;
    // The installer's hook says what it granted and why, since Chromium reports per-app
    // device ids hashed: { device, reason, app }.
    const granted = window.__vcstreamGrantedAudio ?? {};
    if (!audio) return { video, audio: null, audioError: granted.reason ?? "no audio for this source" };
    // Only per-app capture leaves Discord's own sound out; anything else would echo the call.
    if (!String(granted.device ?? "").startsWith("applicationLoopback:")) {
      audio.stop();
      return { video, audio: null, audioError: `system audio would include the voice call (granted "${granted.device}")` };
    }
    return { video, audio, audioError: null, audioApps: [granted.app ?? granted.device.split(":")[1]] };
  } finally {
    clearTimeout(timer);
    window.__vcstreamDisplayRequest = null;
    window.__vcstreamGrantedAudio = null;
  }
}

async function captureRaw({ sourceId, sourceName, width, height, fps, wantAudio }) {
  if (wantAudio && window.__vcstreamSystemAudio) {
    try {
      return await captureWithSystemAudio({ sourceId, width, height, fps });
    } catch (error) {
      // Without audio rather than without a stream.
      const video = await captureRaw({ sourceId, width, height, fps, wantAudio: false });
      return { ...video, audioError: `system audio failed: ${error.name}: ${error.message}` };
    }
  }
  if (wantAudio && navigator.platform.startsWith("Linux") && hostAvailable()) {
    const video = await captureRaw({ sourceId, width, height, fps, wantAudio: false });
    return { ...video, ...(await linuxAppAudio({ sourceId, sourceName })) };
  }
  const video = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxWidth: width,
      maxHeight: height,
      maxFrameRate: fps,
    },
  };
  const blocker = wantAudio ? systemAudioBlocker() : null;
  let audioError = !wantAudio ? "not requested" : blocker;
  if (wantAudio && !blocker) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "desktop" } }, video });
      const audio = stream.getAudioTracks()[0] ?? null;
      return { video: stream.getVideoTracks()[0], audio, audioError: audio ? null : "no audio track returned" };
    } catch (error) {
      // A failed audio capture must not cost us the video.
      audioError = `${error.name}: ${error.message}`;
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  return { video: stream.getVideoTracks()[0], audio: null, audioError };
}
