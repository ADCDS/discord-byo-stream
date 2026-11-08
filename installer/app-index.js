// Written to Discord's resources/app/index.js by the VCStream installer. Discord's
// real app.asar is renamed to vcstream.app.asar and started from here.
const path = require("node:path");
const { app } = require("electron");

const realApp = path.join(__dirname, "..", "vcstream.app.asar");

// Electron names the app after this folder's package.json, and on macOS that name
// picks the Keychain item holding the login. Restore the real identity so logins
// survive installing and uninstalling.
try {
  app.setAppPath(realApp);
  const pkg = require(path.join(realApp, "package.json"));
  const name = pkg.productName ?? pkg.name;
  if (name) app.setName(String(name).trim());
  if (require.main) require.main.filename = path.resolve(realApp, pkg.main);
} catch (error) {
  console.error("VCStream: restoring app identity failed:", error);
}

// A broken VCStream must never stop Discord from starting.
try {
  require(path.join(app.getPath("appData"), "VCStream", "main.js"));
} catch (error) {
  console.error("VCStream: failed to load:", error);
}

module.exports = require(realApp);
