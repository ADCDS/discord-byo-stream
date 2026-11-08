// Builds the plugin and the installer files. Nothing here contains an access key or
// a server address the plugin depends on: the hook reads both from the config.json
// the installer writes, and hands them to the plugin as BYO_ACCESS_KEY and BYO_SERVER.
//
//   node build.mjs
//       The files a server hands out at <server>/dstream/dl (into dist/public). The
//       installer downloads from there and installs for that server. The server comes from
//       byo-stream.config.json, or BYO_SERVER.
//   BYO_RELEASE=linux|macos|windows node build.mjs
//       The files for a GitHub release (into dist/release-files/<platform>). The
//       installer downloads from that release and asks which server to use.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const installer = join(root, "installer");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const release = process.env.BYO_RELEASE;

let outDir;
let defaultServer;
let payloadUrl;
if (release) {
  if (!["linux", "macos", "windows"].includes(release)) throw new Error(`BYO_RELEASE must be linux, macos or windows, got "${release}"`);
  const repo = process.env.GITHUB_REPOSITORY || "ADCDS/discord-byo-stream";
  outDir = join(root, "dist", "release-files", release);
  defaultServer = "";
  payloadUrl = `https://github.com/${repo}/releases/download/${release}-v${version}`;
} else {
  const configFile = join(root, "byo-stream.config.json");
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const server = (process.env.BYO_SERVER || config.server || "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(server)) {
    throw new Error(`set "server" in byo-stream.config.json (see byo-stream.config.example.json) or BYO_SERVER to an https origin, got "${server}"`);
  }
  outDir = join(root, "dist", "public");
  defaultServer = server;
  payloadUrl = `${server}/dstream/dl`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(here, "src/index.js")],
  outfile: join(outDir, "plugin.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "none",
  define: {
    __ACCESS_KEY__: "BYO_ACCESS_KEY",
    __SERVER__: "BYO_SERVER",
    __VERSION__: JSON.stringify(version),
  },
});
for (const file of ["main.js", "app-index.js", "audio-source.js", "linux-audio.js", "install.sh", "install.ps1"]) {
  const text = readFileSync(join(installer, file), "utf8")
    .replaceAll("__BYO_DEFAULT_SERVER__", defaultServer)
    .replaceAll("__BYO_PAYLOAD_URL__", payloadUrl)
    .replaceAll("__BYO_VERSION__", version);
  if (/__BYO_[A-Z_]+__/.test(text)) throw new Error(`${file} has an unknown placeholder: ${text.match(/__BYO_[A-Z_]+__/)[0]}`);
  writeFileSync(join(outDir, file), text);
}
console.log(`built ${outDir}: downloads from ${payloadUrl}, ${defaultServer ? `installs for ${defaultServer}` : "asks for the server"}`);
