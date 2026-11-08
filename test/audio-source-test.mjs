// Unit tests for installer/audio-source.js: which audio a shared window may carry.
//   node test/audio-source-test.mjs
import { createRequire } from "node:module";
const { chooseAudioDevice } = createRequire(import.meta.url)("../installer/audio-source.js");

let failures = 0;
async function check(name, input, expected) {
  const base = {
    platform: "darwin",
    osVersion: "15.1",
    ownPid: 100,
    ownBundle: "com.hnc.Discord",
    sourceId: "window:42:0",
    windowOwner: async () => ({ bundle: "com.example.App", pid: 500 }),
    pidsOfBundle: async () => [],
  };
  const result = await chooseAudioDevice({ ...base, ...input });
  const ok = expected === null ? result.device === null : result.device === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(result)})`}`);
  if (!ok) failures++;
}
const owner = (bundle, pid) => async () => ({ bundle, pid });

await check("whole screen: no audio", { sourceId: "screen:1:0" }, null);
await check("macOS 14.1: no audio (would capture the whole system)", { osVersion: "14.1" }, null);
await check("macOS 13: no audio", { osVersion: "13.6.1" }, null);
await check("macOS 14.2: per-app audio", { osVersion: "14.2" }, "applicationLoopback:com.example.App");
await check("macOS 27: per-app audio", { osVersion: "27.2" }, "applicationLoopback:com.example.App");
await check("other app: bundle only, so its helpers count", {}, "applicationLoopback:com.example.App");
await check("Chrome: browser bundle and pid", { windowOwner: owner("com.google.Chrome", 700) }, "applicationLoopback:com.google.Chrome:700");
await check("Chrome Beta: truncated to Chrome", { windowOwner: owner("com.google.Chrome.beta", 701) }, "applicationLoopback:com.google.Chrome:701");
await check("Edge: browser bundle and pid", { windowOwner: owner("com.microsoft.edgemac", 702) }, "applicationLoopback:com.microsoft.edgemac:702");
await check("Chrome web app: the installing browser", { windowOwner: owner("com.google.Chrome.app.abcdef", 900), pidsOfBundle: async () => [700] }, "applicationLoopback:com.google.Chrome:700");
await check("web app with two browsers running: no audio", { windowOwner: owner("com.google.Chrome.app.abcdef", 900), pidsOfBundle: async () => [700, 701] }, null);
await check("Brave: bundle only", { windowOwner: owner("com.brave.Browser", 800) }, "applicationLoopback:com.brave.Browser");
await check("Safari: WebKit's audio process", { windowOwner: owner("com.apple.Safari", 300) }, "applicationLoopback:com.apple.WebKit.GPU");
await check("Safari Technology Preview: WebKit", { windowOwner: owner("com.apple.SafariTechnologyPreview", 301) }, "applicationLoopback:com.apple.WebKit.GPU");
await check("Safari web app: WebKit", { windowOwner: owner("com.apple.Safari.WebApp.1234-ABCD", 302) }, "applicationLoopback:com.apple.WebKit.GPU");
await check("Discord's own window by pid: no audio", { windowOwner: owner("com.hnc.Discord", 100) }, null);
await check("Discord helper window by bundle: no audio", { windowOwner: owner("com.hnc.Discord.helper.Renderer", 101) }, null);
await check("no bundle id (Wine game): no audio", { windowOwner: owner(undefined, 600) }, null);
await check("invalid bundle id: no audio", { windowOwner: owner("bad id!", 601) }, null);
await check("unknown owner: no audio", { windowOwner: async () => null }, null);
await check("Windows: the owning process tree", { platform: "win32", ownBundle: "", windowOwner: async () => ({ pid: 4321 }) }, "applicationLoopback:4321");
await check("Windows: Discord's own window, no audio", { platform: "win32", ownBundle: "", windowOwner: async () => ({ pid: 100 }) }, null);
await check("Windows: whole screen, no audio", { platform: "win32", sourceId: "screen:0:0" }, null);
await check("Linux: handled elsewhere, no device here", { platform: "linux" }, null);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
