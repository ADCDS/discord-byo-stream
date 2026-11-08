#!/usr/bin/env node
// A system-wide Flatpak Discord is read-only, so the installer can't hook it. This
// loads the plugin over Discord's debug port instead. It writes nothing to Discord's
// files and the plugin is gone once this script stops and Discord restarts.
//
//   flatpak run com.discordapp.Discord --remote-debugging-port=9224
//   node tools/run-in-flatpak-discord.mjs <key-name>
//
// Keep this running while you use it: Discord's content security policy is only
// bypassed for as long as this connection stays open.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { LinuxAudio } = createRequire(import.meta.url)("../installer/linux-audio.js");

const PORT = 9224;
const name = process.argv[2];
if (!name) {
  console.error("usage: run-in-flatpak-discord.mjs <key-name>");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginCode = readFileSync(join(root, "dist", "public", "plugin.js"), "utf8");
const accessKey = readFileSync(join(root, ".keys", `${name}.key`), "utf8").trim();
const server = (process.env.BYO_SERVER || JSON.parse(readFileSync(join(root, "byo-stream.config.json"), "utf8")).server).replace(/\/+$/, "");

// Same contract as installer/main.js: the plugin starts itself.
const loader = `(() => {
  if (window.top !== window) return;
  const boot = () => {
    if (!document.body) return setTimeout(boot, 200);
    (function (BYO_ACCESS_KEY, BYO_SERVER) {
${pluginCode}
    })(${JSON.stringify(accessKey)}, ${JSON.stringify(server)});
  };
  boot();
})();`;

async function findDiscordPage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && /^https:\/\/(\w+\.)?discord\.com\//.test(t.url));
      if (page) return page;
    } catch {
      // Discord may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`no Discord page on port ${PORT}. Was it started with --remote-debugging-port=${PORT}?`);
}

const page = await findDiscordPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("could not connect to the debug port"));
});

let nextId = 0;
const pending = new Map();
const audio = new LinuxAudio((line) => console.log(`[audio] ${line}`));

// The page asks for per-app stream audio through a binding; see linux-audio.mjs.
async function onHostCall({ payload, executionContextId }) {
  let request;
  let result;
  try {
    request = JSON.parse(payload);
    if (request.action === "audio-start") result = await audio.start({ kind: request.kind, title: request.title });
    else if (request.action === "audio-stop") result = await audio.stop();
    else result = { ok: false, error: `unknown action ${request.action}` };
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  if (request?.id == null) return;
  const reply = `window.__byoStreamHostReply?.(${JSON.stringify(request.id)}, ${JSON.stringify(JSON.stringify(result))})`;
  send("Runtime.evaluate", { expression: reply, contextId: executionContextId }).catch(() => {});
}

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.bindingCalled" && message.params.name === "byoStreamHost") {
    onHostCall(message.params);
    return;
  }
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
};
const exit = async (reason) => {
  console.log(reason);
  await audio.shutdown();
  process.exit(0);
};
socket.onclose = () => exit("Discord closed the connection, exiting.");
process.on("SIGINT", () => exit("Stopping."));
process.on("SIGTERM", () => exit("Stopping."));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Runtime.addBinding", { name: "byoStreamHost" });
await send("Page.setBypassCSP", { enabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: loader });
if (process.argv.includes("--no-reload")) {
  // Swaps in a new build without dropping a voice call. Only works if an earlier
  // run already reloaded this page, because that reload is what applied the CSP bypass.
  const { exceptionDetails } = await send("Runtime.evaluate", { expression: loader });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
} else {
  await send("Page.reload");
}
console.log(`BYO Stream loaded for "${name}". Press Ctrl+C to stop.`);
await new Promise(() => {});
