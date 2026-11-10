// BYO Stream's main-process hook, loaded from Discord's app folder before Discord's
// own code. It does two things: lets the page reach our server, and runs the
// plugin in Discord's main window. Failures are logged and never stop Discord.
const { app, desktopCapturer, session } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HOME = path.join(app.getPath("appData"), "discord-byo-stream");
const DISCORD_APP_URL = /^https:\/\/(ptb\.|canary\.)?discord\.com\/(?!popout|overlay)/;

function log(message) {
  try {
    fs.appendFileSync(path.join(HOME, "main.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never be the thing that breaks Discord.
  }
}

/** The installer's config.json: { accessKey, server }. */
function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8"));
    if (typeof config.accessKey === "string" && /^https:\/\/[^/]+$/.test(config.server ?? "")) return config;
    log("config.json has no access key or server; run the installer again");
  } catch (error) {
    log(`config.json unreadable: ${error.message}`);
  }
  return null;
}

const CONFIG = readConfig();

// Chromium features to switch on in Discord, merged into the enable-features list
// Discord sets itself: Chromium keeps only the last value of a switch. On macOS,
// WebRTC can use the hardware HEVC encoder, but Chromium keeps HEVC off by default;
// with these, encoder tests can try it (streams still choose H.264).
const EXTRA_FEATURES = process.platform === "darwin" ? ["WebRtcAllowH265Send", "WebRtcAllowH265Receive"] : [];

function enableFeatures() {
  if (!EXTRA_FEATURES.length) return;
  const commandLine = app.commandLine;
  const merge = (value) => [...new Set([...String(value ?? "").split(","), ...EXTRA_FEATURES].filter(Boolean))].join(",");
  const append = commandLine.appendSwitch.bind(commandLine);
  commandLine.appendSwitch = (name, value) => append(name, name === "enable-features" ? merge(value) : value);
  append("enable-features", merge(commandLine.getSwitchValue("enable-features")));
}

if (CONFIG) {
  try {
    enableFeatures();
  } catch (error) {
    log(`couldn't enable Chromium features: ${error.message}`);
  }
}
// LiveKit must be served from the same host as the token server (at /livekit).
const SERVER_HOST = CONFIG ? new URL(CONFIG.server).host : null;
const SERVER_ORIGINS = SERVER_HOST ? [`https://${SERVER_HOST}`, `wss://${SERVER_HOST}`] : [];

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

// Which app's audio a stream may carry is decided in audio-source.js. These are the
// OS lookups it needs.

// macOS (JXA): "window <CGWindowID>" -> "<bundle id> <pid>" of the window's owner;
// "bundle <id>" -> main pids of running apps with that bundle id.
const MAC_LOOKUP = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  if (argv[0] === "bundle") {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[1]);
    const pids = [];
    for (let i = 0; i < apps.count; i++) pids.push(apps.objectAtIndex(i).processIdentifier);
    return pids.join(" ");
  }
  const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(8, Number(argv[1]))));
  const pid = info && info[0] && info[0].kCGWindowOwnerPID;
  if (!pid) return "";
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const bundle = app.isNil() || app.bundleIdentifier.isNil() ? "" : ObjC.unwrap(app.bundleIdentifier);
  return bundle + " " + pid;
}`;

// Windows: process id owning a window handle.
const WINDOWS_WINDOW_OWNER = `
$ErrorActionPreference = "Stop"
Add-Type -Namespace ByoStream -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);'
$owner = 0
[void][ByoStream.User32]::GetWindowThreadProcessId([System.IntPtr][long]$args[0], [ref]$owner)
$owner`;

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

const macLookup = (...args) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_LOOKUP, ...args]);

async function windowOwner(windowId) {
  if (process.platform === "darwin") {
    const [bundle, pid] = (await macLookup("window", windowId)).split(" ");
    return pid ? { bundle: bundle || undefined, pid: Number(pid) } : null;
  }
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // -EncodedCommand (UTF-16LE base64) sidesteps Windows command-line quoting entirely.
  const command = Buffer.from(`& {${WINDOWS_WINDOW_OWNER}} ${windowId}`, "utf16le").toString("base64");
  const pid = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", command]);
  return /^[1-9]\d*$/.test(pid) ? { pid: Number(pid) } : null;
}

async function pidsOfBundle(bundle) {
  return (await macLookup("bundle", bundle)).split(" ").filter(Boolean).map(Number);
}

let ownBundle;
async function ownBundleId() {
  if (process.platform !== "darwin") return "";
  ownBundle ??= await bundleOfPid(process.pid);
  return ownBundle;
}

async function bundleOfPid(pid) {
  const script = `ObjC.import("AppKit"); function run(argv) { const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])); return a.isNil() || a.bundleIdentifier.isNil() ? "" : ObjC.unwrap(a.bundleIdentifier); }`;
  return run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, String(pid)]);
}

async function audioForSource(sourceId) {
  const { chooseAudioDevice } = require(path.join(HOME, "audio-source.js"));
  return chooseAudioDevice({
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    ownPid: process.pid,
    ownBundle: await ownBundleId(),
    sourceId,
    windowOwner,
    pidsOfBundle,
  });
}

/**
 * Discord sets no display-media handler, so getDisplayMedia is the plugin's own. The
 * plugin names the source it wants on window.__byoStreamDisplayRequest, already picked
 * in Discord's window. The audio device is chosen so Discord's own sound can't be in it.
 */
function handleDisplayMedia(target) {
  if (!SYSTEM_AUDIO || handledSessions.has(target)) return;
  handledSessions.add(target);
  target.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    if (!frame) return callback(null);
    frame
      .executeJavaScript("window.__byoStreamDisplayRequest ?? null")
      .then(async (wanted) => {
        if (!wanted?.sourceId) return callback(null);
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        const video = sources.find((source) => source.id === wanted.sourceId);
        if (!video) {
          log(`display media: source ${wanted.sourceId} not found`);
          return callback(null);
        }
        const choice = wanted.audio && request.audioRequested ? await audioForSource(video.id) : { device: null, reason: null };
        if (wanted.audio) log(`stream audio: ${choice.device ?? `none (${choice.reason})`}`);
        // The page can't verify this itself: Chromium reports per-app device ids hashed.
        await frame.executeJavaScript(`window.__byoStreamGrantedAudio = ${JSON.stringify(choice)};`);
        callback(choice.device ? { video, audio: choice.device } : { video });
      })
      .catch((error) => {
        log(`display media failed: ${error.message}`);
        callback(null);
      });
  });
}

function pluginSource() {
  const code = fs.readFileSync(path.join(HOME, "plugin.js"), "utf8");
  const flags = `window.__byoStreamSystemAudio = ${SYSTEM_AUDIO};\nwindow.__byoStreamConsoleHost = ${Boolean(linuxAudio)};`;
  const args = [CONFIG.accessKey, CONFIG.server].map((value) => JSON.stringify(value)).join(", ");
  return `${flags}\n(function (BYO_ACCESS_KEY, BYO_SERVER) {\n${code}\n})(${args});`;
}

app.whenReady().then(() => {
  if (!CONFIG) return;
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
// The plugin logs with console.log("[BYO Stream]", message).
const LOG_PREFIX = "[BYO Stream] ";
const HOST_PREFIX = "[BYO-Stream-host] ";
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
  const reply = `window.__byoStreamHostReply?.(${JSON.stringify(request.id)}, ${JSON.stringify(JSON.stringify(result))})`;
  contents.executeJavaScript(reply).catch(() => {});
}

// Encoder tests on request: whoever can write to this folder (only the user's own
// account) can ask the plugin to run them. The file holds test settings, not code;
// the plugin checks every value (see plugin/src/benchmark.js).
const DIAGNOSE_FILE = path.join(HOME, "diagnose.json");

function runRequestedDiagnosis(contents) {
  let request;
  try {
    if (!fs.existsSync(DIAGNOSE_FILE) || fs.statSync(DIAGNOSE_FILE).size > 8192) return;
    request = JSON.parse(fs.readFileSync(DIAGNOSE_FILE, "utf8"));
  } catch (error) {
    log(`diagnose.json unreadable: ${error.message}`);
  } finally {
    fs.rmSync(DIAGNOSE_FILE, { force: true });
  }
  if (!request) return;
  contents.executeJavaScript(`window.__byoStream?.diagnose?.(${JSON.stringify(request)})`).catch(() => {});
}

let gpuLogged = false;

function watchPlugin(contents) {
  // By the time Discord's window loads, the GPU process has reported what it can do.
  // "enabled" video_encode means streams can use the hardware encoder.
  if (!gpuLogged) {
    gpuLogged = true;
    const gpu = app.getGPUFeatureStatus();
    log(`gpu: video_encode ${gpu.video_encode}, video_decode ${gpu.video_decode}; enable-features ${app.commandLine.getSwitchValue("enable-features")}`);
    app.getGPUInfo("complete").then((info) => {
      const encoders = info.videoEncodeAcceleratorSupportedProfile ?? info.videoEncodeAcceleratorSupportedProfiles ?? null;
      log(`gpu: hardware video encoders ${JSON.stringify(encoders).slice(0, 800)}`);
    }).catch((error) => log(`gpu info failed: ${error.message}`));
  }
  // Electron 35+ passes one details object; older versions pass (event, level, message).
  contents.on("console-message", (...args) => {
    const message = typeof args[0]?.message === "string" ? args[0].message : args[2];
    if (typeof message !== "string") return;
    if (message.startsWith(LOG_PREFIX)) writePluginLog(message.slice(LOG_PREFIX.length));
    else if (linuxAudio && message.startsWith(HOST_PREFIX)) answerHost(contents, message.slice(HOST_PREFIX.length));
  });
  const timer = setInterval(() => {
    if (contents.isDestroyed()) return clearInterval(timer);
    runRequestedDiagnosis(contents);
    contents
      .executeJavaScript("window.__byoStream?.report ? window.__byoStream.report().then((r) => JSON.stringify(r, null, 1)) : null")
      .then((report) => report && fs.writeFileSync(STATUS_FILE, report))
      .catch(() => {});
  }, 15_000);
}

app.on("web-contents-created", (_event, contents) => {
  if (!CONFIG) return;
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
