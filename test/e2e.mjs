// End-to-end test of the built plugin against the real server, without Discord.
// Two Chrome pages on the https://discord.com origin (so CORS is exercised) load
// dist/public/plugin.js the way installer/main.js does, with Discord's APIs and
// screen capture stubbed by an animated canvas and a test tone.
import { chromium } from "../plugin/node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginCode = readFileSync(join(here, "../dist/public/plugin.js"), "utf8");
const accessKey = readFileSync(join(here, "../.keys/e2e.key"), "utf8").trim();
const server = (process.env.BYO_SERVER || JSON.parse(readFileSync(join(here, "../byo-stream.config.json"), "utf8")).server).replace(/\/+$/, "");
const CHANNEL = `1${String(Date.now()).padStart(17, "0")}`;
// BLOCKS sets how busy the fake screen is. 30 is game-like, 400 is close to incompressible.
const BLOCKS = Number(process.env.BLOCKS ?? 30);
const MODE = process.env.MODE ?? "smooth";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

function stubDiscord({ channel, displayName, blocks }) {
  window.__vc = channel;
  // Linux would refuse system audio because of the echo; the test exercises the audio path.
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  window.__gum = [];
  const store = (name, methods) => ({ _dispatchToken: name, getName: () => name, ...methods });
  const asExports = (s) => ({ exports: { default: s } });
  const stores = [
    store("SelectedChannelStore", { getVoiceChannelId: () => window.__vc }),
    store("UserStore", { getCurrentUser: () => ({ globalName: displayName, username: displayName }) }),
  ];
  const message = new Proxy(function () {}, { get: () => () => ({ locale: "en-US", ast: [] }) });
  const main = {
    c: {
      1: asExports(customElements), // has a getName that throws
      2: asExports(message), // Discord's intl proxy answers to any name
      ...Object.fromEntries(stores.map((s, i) => [10 + i, asExports(s)])),
    },
  };
  // As in Discord, several runtimes answer the push and the store-less one runs last.
  window.webpackChunkdiscord_app = Object.assign([], {
    push(chunk) {
      for (const runtime of [main, { c: {} }, { c: { 3: { exports: {} } } }]) chunk[2](runtime);
      return Array.prototype.push.call(this, chunk);
    },
  });
  window.DiscordNative = {
    desktopCapture: {
      getDesktopCaptureSources: async () => [
        { id: "screen:0:0", name: "Fake screen", url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
        { id: "window:1:0", name: "Fake window", url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
      ],
    },
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__gum.push(constraints);
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const g = canvas.getContext("2d");
    let frame = 0;
    setInterval(() => {
      if (window.__frozen) return; // a still screen produces no new capture frames
      frame++;
      // Busy, constantly changing content so the encoder needs real bitrate,
      // like a game would, plus a solid corner block the viewer can identify.
      for (let i = 0; i < blocks; i++) {
        g.fillStyle = `hsl(${Math.random() * 360} 90% 50%)`;
        g.fillRect(Math.random() * 1280, Math.random() * 720, 60, 60);
      }
      g.fillStyle = frame % 60 < 30 ? "#f00" : "#00f";
      g.fillRect(0, 0, 320, 320);
    }, 33);
    const tracks = canvas.captureStream(30).getVideoTracks();
    if (constraints.audio) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      tracks.push(...dest.stream.getAudioTracks());
    }
    return new MediaStream(tracks);
  };
}

function loadLikeMainProcess({ code, key, server }) {
  new Function("BYO_ACCESS_KEY", "BYO_SERVER", code)(key, server);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

async function client(displayName) {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://discord.com" });
  await context.route("https://discord.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub</title><body></body>" }));
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await page.addInitScript(stubDiscord, { channel: CHANNEL, displayName, blocks: BLOCKS });
  await page.goto("https://discord.com/channels/test");
  await page.evaluate(loadLikeMainProcess, { code: pluginCode, key: accessKey, server });
  return page;
}

try {
  const streamer = await client("Alice");
  const viewer = await client("Bob");
  const button = (page, text) => page.locator("#byo-stream button", { hasText: text });

  await viewer.waitForFunction(() => /2 with plugin/.test(document.querySelector("#byo-stream header")?.textContent ?? ""), null, { timeout: 20000 });
  check("both clients connected to the room", true);

  await button(streamer, "Share screen").click();
  await button(streamer, "Fake screen").waitFor({ timeout: 5000 });
  check("source picker lists capture sources", true);
  await streamer.locator("#byo-stream select").nth(1).selectOption(MODE);
  await button(streamer, "Fake screen").click();
  await streamer.getByText("You're live").waitFor({ timeout: 20000 });
  check("streamer is live", true);

  const gum = await streamer.evaluate(() => window.__gum);
  const videoReq = gum[0]?.video?.mandatory;
  check("video capture uses the picked source", videoReq?.chromeMediaSource === "desktop" && videoReq?.chromeMediaSourceId === "screen:0:0", JSON.stringify(videoReq));
  // On Wayland every capture request opens its own portal dialog.
  check("audio and video come from one capture request", gum.length === 1 && gum[0].audio?.mandatory?.chromeMediaSource === "desktop", `${gum.length} requests`);

  await viewer.getByText("Alice is live").waitFor({ timeout: 15000 });
  check("viewer sees the Discord display name", true);
  await button(viewer, "Watch").click();
  await viewer.waitForFunction(() => document.querySelector("#byo-stream video")?.videoWidth > 0, null, { timeout: 20000 });
  check("viewer decodes video", true);

  const first = await viewer.evaluate(() => document.querySelector("#byo-stream video").currentTime);
  const colors = new Set();
  for (let i = 0; i < 16; i++) {
    colors.add(await viewer.evaluate(() => {
      const v = document.querySelector("#byo-stream video");
      const c = Object.assign(document.createElement("canvas"), { width: 4, height: 4 });
      const g = c.getContext("2d");
      g.drawImage(v, 0, 0, v.videoWidth / 8, v.videoHeight / 8, 0, 0, 4, 4);
      const [r, , b] = g.getImageData(0, 0, 1, 1).data;
      return r > b ? "red" : "blue";
    }));
    await viewer.waitForTimeout(250);
  }
  const last = await viewer.evaluate(() => document.querySelector("#byo-stream video").currentTime);
  check("video keeps playing", last > first + 2, `${first.toFixed(1)}s -> ${last.toFixed(1)}s`);
  check("the actual pixels arrive and change", colors.size === 2, [...colors].join(","));

  // Bandwidth estimation starts low, so resolution and bitrate ramp up over time.
  let rampSeconds = null;
  const startedAt = Date.now();
  let lastLine = "";
  while (Date.now() - startedAt < 30000) {
    await viewer.waitForTimeout(3000);
    lastLine = await viewer.locator("#byo-stream .stats").textContent();
    const sending = await streamer.locator("#byo-stream .stats").textContent();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`      t+${String(elapsed).padStart(2)}s  ${lastLine}   <<  ${sending}`);
    if (rampSeconds === null && /watching 1280x720/.test(lastLine)) rampSeconds = elapsed;
    if (rampSeconds !== null && elapsed >= rampSeconds + 6) break;
  }
  check("ramps up to full resolution", rampSeconds !== null, `after ${rampSeconds}s`);

  const audioPeak = await viewer.evaluate(async () => {
    const stream = document.querySelector("audio")?.srcObject ?? window.__byoStream.audioEl?.srcObject;
    if (!stream) return -1;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(data);
      peak = Math.max(peak, ...data.map(Math.abs));
    }
    return peak;
  });
  check("audio arrives with real signal", audioPeak > 0.01, `peak ${audioPeak.toFixed(3)}`);

  const watchLine = await viewer.locator("#byo-stream .stats").textContent();
  const sendLine = await streamer.locator("#byo-stream .stats").textContent();
  check("media uses UDP, not the TCP fallback", / udp$/.test(watchLine) && / udp$/.test(sendLine));

  await button(viewer, "Copy diagnostics").click();
  await viewer.waitForTimeout(300);
  const diagnostics = await viewer.evaluate(() => navigator.clipboard.readText());
  check("diagnostics copy works", JSON.parse(diagnostics).room === "connected");
  check("diagnostics never contain the access key", !diagnostics.includes(accessKey));

  // A late viewer of a still screen: the reported black stream.
  await button(viewer, "Close").click();
  await streamer.evaluate(() => { window.__frozen = true; });
  await viewer.waitForTimeout(3000);
  await button(viewer, "Watch").click();
  const stillPicture = await viewer.waitForFunction(() => document.querySelector("#byo-stream video")?.videoWidth > 0, null, { timeout: 15000 }).then(() => true, () => false);
  check("a late viewer of a still screen gets a picture", stillPicture);
  await streamer.evaluate(() => { window.__frozen = false; });

  await button(streamer, "Stop").click();
  await viewer.getByText("Alice is live").waitFor({ state: "detached", timeout: 15000 });
  check("stream ending clears it for the viewer", (await viewer.locator("#byo-stream video").count()) === 0);
  await button(streamer, "Share screen").waitFor({ timeout: 5000 });
  check("streamer can share again after stopping", true);

  await viewer.evaluate(() => { window.__vc = null; });
  await viewer.waitForFunction(() => document.querySelector("#byo-stream")?.hidden === true, null, { timeout: 5000 });
  check("leaving the voice channel hides the panel", true);

  await streamer.evaluate(() => window.__byoStream.stop());
  check("disabling the plugin removes its UI", (await streamer.locator("#byo-stream, #byo-stream-style").count()) === 0);
  check("no uncaught page errors", streamer.errors.length + viewer.errors.length === 0, [...streamer.errors, ...viewer.errors].join("; "));
} catch (error) {
  check("test ran to completion", false, error.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
console.log(`room used: discord-${CHANNEL}`);
process.exit(failures ? 1 : 0);
