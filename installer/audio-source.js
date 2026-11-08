// Chooses the audio device for a shared window so the Discord call can't be in it.
// Pure logic: the OS lookups are passed in, so this runs (and is tested) anywhere.
//
// Chromium's "without Chrome" loopback only leaves out its own audio service process,
// but Discord's voice engine plays from the renderer, so the call would leak into the
// stream. So BYO Stream records only the app that owns the shared window, using
// Chromium's per-application loopback device ids. Whole screens get no audio: neither
// macOS nor Windows offers Chromium "everything except this app".

// Mirrors Chromium's own mapping in content/browser/media/capture/desktop_capture_util_mac.mm.
const CHROMIUM_BROWSERS = ["com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac", "com.operasoftware.Opera"];
const PWA_INFIX = ".app.";
// Safari plays web audio from WebKit's shared GPU process, not its own (not in Chromium).
const WEBKIT_AUDIO = "com.apple.WebKit.GPU";
const SAFARI_FAMILY = /^com\.apple\.(Safari|SafariTechnologyPreview)(\.WebApp\..*)?$/;
// Per-app capture uses CoreAudio taps, which Chromium uses on macOS 14.2+. On older
// macOS any loopback id falls back to ScreenCaptureKit, which records the whole system.
const MIN_MACOS = [14, 2];

function versionAtLeast(version, [major, minor]) {
  const [a = 0, b = 0] = String(version).split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

/**
 * @param {object} p
 * @param {string} p.platform       process.platform
 * @param {string} p.osVersion      process.getSystemVersion()
 * @param {number} p.ownPid         this app's main process id
 * @param {string} p.ownBundle      this app's bundle id on macOS, e.g. "com.hnc.Discord"
 * @param {string} p.sourceId       desktopCapturer id of the shared source
 * @param {(windowId: string) => Promise<{bundle?: string, pid?: number} | null>} p.windowOwner
 * @param {(bundle: string) => Promise<number[]>} p.pidsOfBundle   running main pids for a bundle id
 * @returns {Promise<{device: string | null, reason: string | null, app?: string}>}
 */
async function chooseAudioDevice({ platform, osVersion, ownPid, ownBundle, sourceId, windowOwner, pidsOfBundle }) {
  const none = (reason) => ({ device: null, reason });
  const windowId = String(sourceId).match(/^window:(\d+):/)?.[1];
  if (!windowId) return none("a whole-screen share can't leave Discord's voice out, so it has no audio");
  if (platform !== "darwin" && platform !== "win32") return none("unsupported platform");
  if (platform === "darwin" && !versionAtLeast(osVersion, MIN_MACOS)) {
    return none(`stream audio needs macOS ${MIN_MACOS.join(".")} or later`);
  }

  const owner = await windowOwner(windowId);
  if (!owner?.pid) return none("couldn't tell which app owns that window");
  if (owner.pid === ownPid || (ownBundle && owner.bundle?.startsWith(ownBundle))) {
    return none("sharing a Discord window would echo the call, so it has no audio");
  }

  if (platform === "win32") {
    // Includes the process tree, e.g. a browser and its audio process.
    return { device: `applicationLoopback:${owner.pid}`, reason: null, app: `process ${owner.pid}` };
  }

  const bundle = owner.bundle ?? "";
  if (!/^[A-Za-z0-9.-]+$/.test(bundle)) return none("that app has no bundle id macOS can record audio from");
  if (SAFARI_FAMILY.test(bundle)) return { device: `applicationLoopback:${WEBKIT_AUDIO}`, reason: null, app: "Safari (WebKit)" };

  const browser = CHROMIUM_BROWSERS.find((prefix) => bundle.startsWith(prefix));
  if (!browser) return { device: `applicationLoopback:${bundle}`, reason: null, app: bundle };
  if (!bundle.includes(PWA_INFIX)) return { device: `applicationLoopback:${browser}:${owner.pid}`, reason: null, app: browser };

  // An installed web app plays through the browser that installed it.
  const pids = await pidsOfBundle(bundle.slice(0, bundle.indexOf(PWA_INFIX)));
  if (pids.length !== 1) return none("couldn't tell which browser runs that web app");
  return { device: `applicationLoopback:${browser}:${pids[0]}`, reason: null, app: browser };
}

module.exports = { chooseAudioDevice };
