// Written to Discord's resources/app/index.js by the BYO Stream installer. Discord's
// real app.asar is renamed to byo-stream.app.asar and started from here.
const path = require("node:path");
const { app } = require("electron");

const realApp = path.join(__dirname, "..", "byo-stream.app.asar");

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
  console.error("BYO Stream: restoring app identity failed:", error);
}

// A broken BYO Stream must never stop Discord from starting.
try {
  require(path.join(app.getPath("appData"), "discord-byo-stream", "main.js"));
} catch (error) {
  console.error("BYO Stream: failed to load:", error);
}

module.exports = require(realApp);
