// VCStream's main-process hook, loaded from Discord's app folder before Discord's
// own code. It does two things: lets the page reach our server, and runs the
// plugin in Discord's main window. Failures are logged and never stop Discord.
const { app, desktopCapturer, session } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HOME = path.join(app.getPath("appData"), "VCStream");
// Filled in by the build from vcstream.config.json. LiveKit must be served from the
// same host (VCStream's server proxies it at /livekit).
const SERVER_HOST = new URL("__VCSTREAM_SERVER__").host;
const SERVER_ORIGINS = [`https://${SERVER_HOST}`, `wss://${SERVER_HOST}`];
const DISCORD_APP_URL = /^https:\/\/(ptb\.|canary\.)?discord\.com\/(?!popout|overlay)/;

function log(message) {
  try {
    fs.appendFileSync(path.join(HOME, "main.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never be the thing that breaks Discord.
  }
}

/** Adds our server to connect-src, leaving the rest of Discord's policy intact. */
function allowServer(headers) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "content-security-policy") continue;
    headers[name] = headers[name].map((policy) => {
      if (/(^|;)\s*connect-src\s/i.test(policy)) {
        return policy.replace(/((?:^|;)\s*connect-src\s)/i, `$1${SERVER_ORIGINS.join(" ")} `);
      }
      return policy;
    });
  }
  return headers;
}

/**
 * Electron keeps one onHeadersReceived listener per session and a later call
 * replaces the earlier one. Discord registers its own, so its listener runs
 * inside ours rather than removing it.
 */
function patchHeaders() {
  const webRequest = session.defaultSession.webRequest;
  const register = webRequest.onHeadersReceived.bind(webRequest);
  let discordListener = null;
  webRequest.onHeadersReceived = (...args) => {
    discordListener = args[args.length - 1];
  };
  register((details, callback) => {
    const finish = (result = {}) => {
      const headers = result.responseHeaders ?? details.responseHeaders ?? {};
      callback({ ...result, responseHeaders: allowServer(headers) });
    };
    if (discordListener) discordListener(details, finish);
    else finish();
  });
}

// Chromium can capture system audio minus this app's own processes (and so minus the
// voice call) only on these, and only through the display-media handler below.
const SYSTEM_AUDIO = process.platform === "darwin" || process.platform === "win32";
const handledSessions = new WeakSet();

// Chromium's "without Chrome" loopback only leaves out its own audio service process.
// Discord's voice engine plays from the renderer, so the call would leak into the
// stream (verified on macOS; on Windows it excludes the same process). Instead, record
// only the app that owns the shared window. A whole screen gets no audio: neither
// platform offers "everything except this app" to Chromium.

// macOS: owner of a CGWindowID as "<bundle id> <pid>".
const MAC_WINDOW_OWNER = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(8, Number(argv[0]))));
  const pid = info && info[0] && info[0].kCGWindowOwnerPID;
  if (!pid) return "";
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  return app.isNil() ? "" : ObjC.unwrap(app.bundleIdentifier) + " " + pid;
}`;

// Windows: process id owning a window handle.
const WINDOWS_WINDOW_OWNER = `
$ErrorActionPreference = "Stop"
Add-Type -Namespace VCStream -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);'
$owner = 0
[void][VCStream.User32]::GetWindowThreadProcessId([System.IntPtr][long]$args[0], [ref]$owner)
$owner`;

// macOS apps whose sound comes from a shared system process instead of their own.
const AUDIO_PROCESS_OF = { "com.apple.Safari": "com.apple.WebKit.GPU" };

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

/** Chromium's device id for the shared app's audio, or null if there's no safe choice. */
async function appAudioDevice(sourceId) {
  const windowId = sourceId.match(/^window:(\d+):/)?.[1];
  if (!windowId) return null;
  if (process.platform === "darwin") {
    const [bundle, pid] = (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_WINDOW_OWNER, windowId])).split(" ");
    if (!bundle) return null;
    const shared = AUDIO_PROCESS_OF[bundle];
    return shared ? `applicationLoopback:${shared}` : `applicationLoopback:${bundle}:${pid}`;
  }
  if (process.platform === "win32") {
    // Captures this process and its children, e.g. a browser and its audio process.
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // -EncodedCommand (UTF-16LE base64) sidesteps Windows command-line quoting entirely.
    const command = Buffer.from(`& {${WINDOWS_WINDOW_OWNER}} ${windowId}`, "utf16le").toString("base64");
    const pid = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", command]);
    return /^[1-9]\d*$/.test(pid) ? `applicationLoopback:${pid}` : null;
  }
  return null;
}

/**
 * Discord sets no display-media handler, so getDisplayMedia is the plugin's own. The
 * plugin names the source it wants on window.__vcstreamDisplayRequest, already picked
 * in Discord's window. The audio device is chosen so Discord's own sound can't be in it.
 */
function handleDisplayMedia(target) {
  if (!SYSTEM_AUDIO || handledSessions.has(target)) return;
  handledSessions.add(target);
  target.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    if (!frame) return callback(null);
    frame
      .executeJavaScript("window.__vcstreamDisplayRequest ?? null")
      .then(async (wanted) => {
        if (!wanted?.sourceId) return callback(null);
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        const video = sources.find((source) => source.id === wanted.sourceId);
        if (!video) {
          log(`display media: source ${wanted.sourceId} not found`);
          return callback(null);
        }
        const audio = wanted.audio && request.audioRequested ? await appAudioDevice(video.id) : null;
        // The page can't verify this itself: Chromium reports per-app device ids hashed.
        await frame.executeJavaScript(`window.__vcstreamGrantedAudio = ${JSON.stringify(audio)};`);
        callback(audio ? { video, audio } : { video });
      })
      .catch((error) => {
        log(`display media failed: ${error.message}`);
        callback(null);
      });
  });
}

function pluginSource() {
  const { accessKey } = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8"));
  const code = fs.readFileSync(path.join(HOME, "plugin.js"), "utf8");
  const flags = `window.__vcstreamSystemAudio = ${SYSTEM_AUDIO};\nwindow.__vcstreamConsoleHost = ${Boolean(linuxAudio)};`;
  return `${flags}\n(function (VCSTREAM_ACCESS_KEY) {\n${code}\n})(${JSON.stringify(accessKey)});`;
}

app.whenReady().then(() => {
  try {
    patchHeaders();
    log(`hooked, Discord ${app.getVersion()} Electron ${process.versions.electron}`);
  } catch (error) {
    log(`header patch failed: ${error.stack}`);
  }
});

// The plugin's own log and a periodic status report go to files next to this one,
// so problems can be read without asking anyone to copy anything.
const PLUGIN_LOG = path.join(HOME, "plugin.log");
const STATUS_FILE = path.join(HOME, "status.json");
const LOG_LIMIT_BYTES = 1024 * 1024;

function writePluginLog(line) {
  try {
    if (fs.existsSync(PLUGIN_LOG) && fs.statSync(PLUGIN_LOG).size > LOG_LIMIT_BYTES) {
      fs.renameSync(PLUGIN_LOG, `${PLUGIN_LOG}.old`);
    }
    fs.appendFileSync(PLUGIN_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break Discord.
  }
}

// Linux: per-app stream audio through PipeWire (see linux-audio.js). The plugin asks
// for it with console messages, since the page has no other channel to this process.
const HOST_PREFIX = "[VCStream-host] ";
let linuxAudio = null;
if (process.platform === "linux") {
  try {
    const { LinuxAudio } = require(path.join(HOME, "linux-audio.js"));
    linuxAudio = new LinuxAudio((line) => writePluginLog(`audio: ${line}`));
    app.on("will-quit", () => linuxAudio.shutdownSync());
  } catch (error) {
    log(`linux audio helper unavailable: ${error.message}`);
  }
}

async function answerHost(contents, json) {
  let request;
  let result;
  try {
    request = JSON.parse(json);
    if (request.action === "audio-start") result = await linuxAudio.start({ kind: request.kind, title: request.title });
    else if (request.action === "audio-stop") result = await linuxAudio.stop();
    else result = { ok: false, error: `unknown action ${request.action}` };
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  if (request?.id == null || contents.isDestroyed()) return;
  const reply = `window.__vcstreamHostReply?.(${JSON.stringify(request.id)}, ${JSON.stringify(JSON.stringify(result))})`;
  contents.executeJavaScript(reply).catch(() => {});
}

function watchPlugin(contents) {
  // Electron 35+ passes one details object; older versions pass (event, level, message).
  contents.on("console-message", (...args) => {
    const message = typeof args[0]?.message === "string" ? args[0].message : args[2];
    if (typeof message !== "string") return;
    if (message.startsWith("[VCStream]")) writePluginLog(message.slice(11));
    else if (linuxAudio && message.startsWith(HOST_PREFIX)) answerHost(contents, message.slice(HOST_PREFIX.length));
  });
  const timer = setInterval(() => {
    if (contents.isDestroyed()) return clearInterval(timer);
    contents
      .executeJavaScript("window.__vcstream?.report ? window.__vcstream.report().then((r) => JSON.stringify(r, null, 1)) : null")
      .then((report) => report && fs.writeFileSync(STATUS_FILE, report))
      .catch(() => {});
  }, 15_000);
}

app.on("web-contents-created", (_event, contents) => {
  let watched = false;
  contents.on("dom-ready", () => {
    if (!watched && contents.getType() === "window" && DISCORD_APP_URL.test(contents.getURL())) {
      watched = true;
      watchPlugin(contents);
      handleDisplayMedia(contents.session);
    }
    if (contents.getType() !== "window" || !DISCORD_APP_URL.test(contents.getURL())) return;
    try {
      contents.executeJavaScript(pluginSource()).catch((error) => log(`plugin failed: ${error.stack ?? error}`));
    } catch (error) {
      log(`plugin load failed: ${error.stack}`);
    }
  });
});
