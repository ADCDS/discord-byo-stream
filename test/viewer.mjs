// Headless second participant for testing a real stream without a second person.
// Reports stats and whether frames are changing. It never saves or prints the image.
//   node test/viewer.mjs <voice channel id> [seconds]
import { chromium } from "../plugin/node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const channel = process.argv[2];
const seconds = Number(process.argv[3] ?? 60);
if (!/^\d{15,25}$/.test(channel ?? "")) {
  console.error("usage: viewer.mjs <voice channel id> [seconds]");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, "../dist/public/plugin.js"), "utf8");
const accessKey = readFileSync(join(here, "../.keys/e2e.key"), "utf8").trim();
const server = (process.env.BYO_SERVER || JSON.parse(readFileSync(join(here, "../byo-stream.config.json"), "utf8")).server).replace(/\/+$/, "");

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
await context.route("https://discord.com/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><title>viewer</title><body></body>" }));
const page = await context.newPage();
await page.addInitScript((id) => {
  const store = (name, methods) => ({ exports: { default: { _dispatchToken: name, getName: () => name, ...methods } } });
  const runtime = {
    c: {
      1: store("SelectedChannelStore", { getVoiceChannelId: () => id }),
      2: store("UserStore", { getCurrentUser: () => ({ globalName: "test viewer" }) }),
    },
  };
  window.webpackChunkdiscord_app = Object.assign([], {
    push(chunk) { chunk[2](runtime); return Array.prototype.push.call(this, chunk); },
  });
}, channel);
await page.goto("https://discord.com/channels/test");
await page.evaluate(({ source, key, server }) => new Function("BYO_ACCESS_KEY", "BYO_SERVER", source)(key, server), { source: code, key: accessKey, server });

// Coarse 8x8 brightness signature: enough to tell frames apart, useless as an image.
const signature = () => page.evaluate(() => {
  const video = document.querySelector("#byo-stream video");
  if (!video?.videoWidth) return null;
  const canvas = Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
  const g = canvas.getContext("2d");
  g.drawImage(video, 0, 0, 8, 8);
  const data = g.getImageData(0, 0, 8, 8).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i] + data[i + 1] + data[i + 2]) >>> 0;
  return sum;
});

const deadline = Date.now() + seconds * 1000;
let watching = false;
let distinctFrames = new Set();
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  if (!watching) {
    const watch = page.locator("#byo-stream button", { hasText: "Watch" });
    if (await watch.count()) {
      console.log("stream found:", await page.locator("#byo-stream .row .grow").first().textContent());
      await watch.first().click();
      watching = true;
    } else {
      console.log("waiting for a stream:", await page.locator("#byo-stream header span").textContent());
      continue;
    }
  }
  const frame = await signature();
  if (frame !== null) distinctFrames.add(frame);
  const audio = await page.evaluate(async () => {
    const stream = window.__byoStream.audioEl?.srcObject;
    if (!stream?.getAudioTracks().length) return "none";
    // Peak level over half a second, to tell real sound from silence.
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(data);
      peak = Math.max(peak, ...data.map(Math.abs));
    }
    ctx.close();
    return `peak ${peak.toFixed(3)}`;
  });
  console.log(`${await page.locator("#byo-stream .stats").textContent()} | audio ${audio} distinctFrames=${distinctFrames.size}`);
}
// SNAPSHOT=path saves one frame as the viewer sees it, only when asked.
if (process.env.SNAPSHOT && watching) {
  await page.locator("#byo-stream video").screenshot({ path: process.env.SNAPSHOT }).catch((error) => console.log(`snapshot failed: ${error.message}`));
}
await browser.close();
