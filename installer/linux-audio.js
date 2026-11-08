// Per-app stream audio on Linux through PipeWire, like Discord's own engine does it.
// Chromium can only record whole-system audio, which includes the voice call, so
// friends would hear themselves. Instead, the chosen apps' outputs are linked into a
// private null sink, and the plugin records that sink's monitor. Links are added next
// to the apps' normal outputs, so nothing you hear changes.
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const SINK_NAME = "byo_stream_share";
const SOURCE_NAME = "byo_stream_capture";
// Chromium hides monitor sources from its input list, so a virtual input reads the
// sink's monitor. This label is what the plugin looks for.
const SOURCE_LABEL = "BYO-Stream"; // no spaces: pactl splits module arguments on them
const SYNC_MS = 2000;

/** Discord's own audio: the voice call, and streams it plays back. Never captured. */
function isDiscord(props) {
  return (
    /discord/i.test(props["application.process.binary"] ?? "") ||
    /^com\.discordapp\./.test(props["pipewire.access.portal.app_id"] ?? "") ||
    props["application.name"] === "WEBRTC VoiceEngine"
  );
}

/** Whether a window title names this app, e.g. "Twitch - Brave" and app "Brave". */
function matchesTitle(title, props) {
  const haystack = title.toLowerCase();
  return [props["application.name"], props["application.process.binary"], props["application.id"]]
    .filter((name) => typeof name === "string" && name.length >= 3)
    .some((name) => haystack.includes(name.toLowerCase()));
}

async function listPorts() {
  const { stdout } = await run("pw-cli", ["ls", "Port"]);
  const ports = [];
  let current = null;
  for (const line of stdout.split("\n")) {
    const header = line.match(/^\s*id (\d+), type PipeWire:Interface:Port/);
    if (header) {
      current = { id: header[1] };
      ports.push(current);
      continue;
    }
    const property = line.match(/^\s*([\w.]+) = "(.*)"/);
    if (property && current) current[property[1]] = property[2];
  }
  return ports;
}

async function pactlJson(...args) {
  const { stdout } = await run("pactl", ["-f", "json", ...args]);
  return JSON.parse(stdout);
}

class LinuxAudio {
  constructor(log) {
    this.log = log;
    this.links = new Set(); // "outPort inPort"
    this.target = null; // { kind, title }
    this.createdModules = [];
    this.timer = null;
    this.lastChoice = "";
  }

  async start({ kind, title }) {
    await this.stop();
    await this.ensureSink();
    this.target = { kind, title: typeof title === "string" ? title : "" };
    const apps = await this.sync();
    this.timer = setInterval(() => this.sync().catch((error) => this.log(`audio sync failed: ${error.message}`)), SYNC_MS);
    return { ok: true, device: SOURCE_LABEL, apps };
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.target = null;
    for (const link of this.links) {
      const [out, input] = link.split(" ");
      await run("pw-link", ["-d", out, input]).catch(() => {}); // Gone already if the app quit.
    }
    this.links.clear();
    this.lastChoice = "";
    return { ok: true };
  }

  /** Like shutdown(), for exit handlers that can't wait. */
  shutdownSync() {
    clearInterval(this.timer);
    for (const link of this.links) {
      try {
        execFileSync("pw-link", ["-d", ...link.split(" ")], { stdio: "ignore" });
      } catch {
        // Gone already if the app quit.
      }
    }
    this.links.clear();
    for (const module of this.createdModules.reverse()) {
      try {
        execFileSync("pactl", ["unload-module", module], { stdio: "ignore" });
      } catch {
        // Already unloaded.
      }
    }
    this.createdModules = [];
  }

  /** Removes the sink too. Called when the loader exits. */
  async shutdown() {
    await this.stop();
    for (const module of this.createdModules.reverse()) {
      await run("pactl", ["unload-module", module]).catch(() => {});
    }
    this.createdModules = [];
  }

  async ensureSink() {
    const load = async (...args) => {
      const { stdout } = await run("pactl", ["load-module", ...args]);
      this.createdModules.push(stdout.trim());
    };
    const sinks = await pactlJson("list", "sinks");
    if (!sinks.some((sink) => sink.name === SINK_NAME)) {
      await load("module-null-sink", `sink_name=${SINK_NAME}`, "sink_properties=device.description=BYO-Stream-share", "channel_map=front-left,front-right");
    }
    const sources = await pactlJson("list", "sources");
    if (!sources.some((source) => source.name === SOURCE_NAME)) {
      await load("module-remap-source", `master=${SINK_NAME}.monitor`, `source_name=${SOURCE_NAME}`, `source_properties=device.description=${SOURCE_LABEL}`, "channel_map=front-left,front-right");
      this.log("created the BYO Stream capture device");
    }
  }

  /** Links every stream that should be heard and isn't linked yet. Returns their names. */
  async sync() {
    // stop() can clear the target while this runs, so work from a snapshot.
    const target = this.target;
    if (!target) return [];
    const [sinks, inputs, ports] = await Promise.all([pactlJson("list", "sinks"), pactlJson("list", "sink-inputs"), listPorts()]);
    const sink = sinks.find((s) => s.name === SINK_NAME);
    if (!sink) throw new Error("capture sink disappeared");
    const sinkNode = sink.properties["object.id"];
    const sinkIn = Object.fromEntries(
      ports.filter((p) => p["node.id"] === sinkNode && p["port.direction"] === "in").map((p) => [p["audio.channel"], p.id]),
    );

    const candidates = inputs.filter((input) => input.sink !== sink.index && !isDiscord(input.properties));
    let chosen = candidates;
    if (target.kind === "window" && target.title) {
      const matched = candidates.filter((input) => matchesTitle(target.title, input.properties));
      if (matched.length) chosen = matched;
    }

    const names = [...new Set(chosen.map((input) => input.properties["application.name"] ?? "unknown"))];
    const choice = names.join(", ");
    if (choice !== this.lastChoice) {
      this.lastChoice = choice;
      this.log(`stream audio from: ${choice || "nothing playing yet"}`);
    }

    const portIds = new Set(ports.map((p) => p.id));
    for (const link of [...this.links]) {
      if (!portIds.has(link.split(" ")[0])) this.links.delete(link); // The app's stream ended.
    }
    for (const input of chosen) {
      const node = input.properties["object.id"];
      const outs = ports.filter((p) => p["node.id"] === node && p["port.direction"] === "out" && p["port.monitor"] !== "true");
      for (const out of outs) {
        const channel = out["audio.channel"];
        const targets = channel === "FL" || channel === "FR" ? [sinkIn[channel]] : [sinkIn.FL, sinkIn.FR];
        for (const input of targets.filter(Boolean)) {
          const link = `${out.id} ${input}`;
          if (this.links.has(link) || this.target !== target) continue;
          // Only links created here are ours to remove later.
          const created = await run("pw-link", [out.id, input]).then(
            () => true,
            (error) => {
              if (/exists/i.test(error.stderr ?? "")) return false;
              throw error;
            },
          );
          if (created) this.links.add(link);
        }
      }
    }
    return names;
  }
}

module.exports = { LinuxAudio };
