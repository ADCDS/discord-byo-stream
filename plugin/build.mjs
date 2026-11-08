// Builds everything the server hands out into dist/public, for the server named in
// vcstream.config.json. Nothing here contains an access key: the loader supplies
// VCSTREAM_ACCESS_KEY at runtime.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installer = join(here, "..", "installer");
const outDir = join(here, "..", "dist", "public");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const config = JSON.parse(readFileSync(join(here, "..", "vcstream.config.json"), "utf8"));

// The token server, also serving the installer files under /dstream/dl.
const server = (process.env.VCSTREAM_SERVER || config.server || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(server)) {
  throw new Error(`set "server" in vcstream.config.json (or VCSTREAM_SERVER) to an https origin, got "${server}"`);
}

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
    __ACCESS_KEY__: "VCSTREAM_ACCESS_KEY",
    __API_URL__: JSON.stringify(`${server}/dstream`),
    __VERSION__: JSON.stringify(version),
  },
});
for (const file of ["main.js", "app-index.js", "linux-audio.js", "install.sh", "install.ps1"]) {
  const text = readFileSync(join(installer, file), "utf8").replaceAll("__VCSTREAM_SERVER__", server);
  writeFileSync(join(outDir, file), text);
}
console.log(`built ${outDir} for ${server}`);
