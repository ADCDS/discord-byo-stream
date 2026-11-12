// A floating panel while you're in a voice channel.
import { capture, getDisplayName, getStore, getUserId, getVoiceChannelId, listSources, systemAudioBlocker } from "./discord.js";
import { runBenchmark } from "./benchmark.js";
import { describeEncoders } from "./encoder.js";
import { warmUpH264Decoding } from "./h264-warmup.js";
import { NativeBridge } from "./native.js";
import { MODES, QUALITY, Session } from "./session.js";
import { publisherStats, viewerStats } from "./stats.js";

const API_URL = `${__SERVER__}/dstream`;
const ACCESS_KEY = __ACCESS_KEY__;
const VERSION = __VERSION__;
const POLL_MS = 1500;
const STATS_MS = 2000;
const LOG_LIMIT = 60;
const LOOKUP_GRACE_MS = 30_000;
const NATIVE_GRACE_MS = 45_000;
const DEBUG_SHORTCUT = (event) => event.ctrlKey && event.altKey && event.code === "KeyV";

const CSS = `
#byo-stream{position:fixed;right:16px;bottom:16px;width:320px;z-index:10000;background:#1e1f22;color:#dbdee1;
  border:1px solid #3f4147;border-radius:8px;font:13px/1.4 "gg sans",system-ui,sans-serif;box-shadow:0 8px 24px #0008}
#byo-stream.wide{width:min(960px,calc(100vw - 32px))}
#byo-stream header{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;user-select:none;font-weight:600}
#byo-stream header span{flex:1;font-weight:400;color:#b5bac1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#byo-stream .body{padding:0 10px 10px;display:flex;flex-direction:column;gap:8px}
#byo-stream button{background:#4e5058;color:#fff;border:0;border-radius:4px;padding:5px 10px;font:inherit;cursor:pointer}
#byo-stream button:hover{background:#6d6f78}
#byo-stream button.primary{background:#5865f2}
#byo-stream button.primary:hover{background:#4752c4}
#byo-stream button.danger{background:#da373c}
#byo-stream select{background:#2b2d31;color:#dbdee1;border:1px solid #3f4147;border-radius:4px;padding:4px;font:inherit}
#byo-stream .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#byo-stream .row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#byo-stream .error{color:#fa777c;overflow-wrap:anywhere}
#byo-stream .stats{font:11px/1.4 ui-monospace,monospace;color:#949ba4;overflow-wrap:anywhere}
#byo-stream video{width:100%;background:#000;border-radius:4px;display:block;max-height:70vh}
#byo-stream .sources{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;max-height:280px;overflow:auto}
#byo-stream .source{background:#2b2d31;padding:4px;text-align:left;overflow:hidden}
#byo-stream .source img{width:100%;display:block;border-radius:2px;background:#000;aspect-ratio:16/9;object-fit:contain}
#byo-stream .source div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;margin-top:2px}
`;

function getCurrentUserPremium() {
  return getStore("UserStore")?.getCurrentUser?.()?.premiumType ?? 0;
}

/** A short Discord-style notice at the top of the window. */
function notify(text, ms = 9000) {
  const box = el("div", {
    textContent: text,
    style: "position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:10001;max-width:min(560px,90vw);" +
      "background:#2b2d31;color:#dbdee1;border:1px solid #3f4147;border-left:4px solid #f0b232;border-radius:8px;" +
      "padding:10px 14px;font:14px/1.4 \"gg sans\",system-ui,sans-serif;box-shadow:0 8px 24px #0008",
  });
  document.body.append(box);
  setTimeout(() => box.remove(), ms);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

class ByoStream {
  start() {
    this.logs = [];
    this.session = null;
    this.channelId = null;
    this.error = null;
    this.picker = null;
    this.wantAudio = !systemAudioBlocker();
    this.quality = "1080p30";
    this.mode = "smooth";
    this.statsText = "";
    this.statsData = null;
    this.videoEl = null;
    this.audioEl = null;
    this.volume = 1;

    this.style = el("style", { id: "byo-stream-style", textContent: CSS });
    document.head.append(this.style);
    this.root = el("div", { id: "byo-stream", hidden: true });
    document.body.append(this.root);

    this.startedAt = Date.now();
    this.native = null;
    this.debugOpen = false;
    this.onKeyDown = (event) => {
      if (!DEBUG_SHORTCUT(event)) return;
      this.debugOpen = !this.debugOpen;
      this.render();
    };
    document.addEventListener("keydown", this.onKeyDown);

    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
    this.statsTimer = setInterval(() => this.refreshStats(), STATS_MS);
    this.tick();
    this.log(`started v${VERSION}`);
    warmUpH264Decoding(this.log);
    describeEncoders().then((line) => this.log(`video encoders: ${line}`)).catch(() => {});
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.statsTimer);
    document.removeEventListener("keydown", this.onKeyDown);
    this.native?.uninstall();
    this.native = null;
    this.closeSession();
    this.detachMedia();
    this.root?.remove();
    this.style?.remove();
    document.removeEventListener("mousemove", this.onDragMove);
    document.removeEventListener("mouseup", this.onDragEnd);
  }

  log = (message) => {
    console.log("[BYO Stream]", message);
    this.logs.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
    if (this.logs.length > LOG_LIMIT) this.logs.shift();
  };

  fail(context, error) {
    const text = `${context}: ${error?.name ?? "Error"}: ${error?.message ?? error}`;
    this.error = text;
    this.log(text);
    this.render();
  }

  tick() {
    this.installNative();
    this.syncChannel();
  }

  /**
   * Prefers Discord's own UI. If a Discord update breaks that, the floating panel
   * takes over after a grace period, so sharing keeps working either way.
   */
  installNative() {
    if (this.native || this.nativeGaveUp) return;
    const bridge = new NativeBridge({
      getSession: () => this.session,
      startCapture: (session, source) => this.shareFromNative(session, source),
      pickSource: () => this.pickSourceFromSystem(),
      log: this.log,
    });
    try {
      bridge.install();
    } catch (error) {
      if (error.message !== this.lastNativeError) this.log(`native UI not ready: ${error.message}`);
      this.lastNativeError = error.message;
      if (Date.now() - this.startedAt <= NATIVE_GRACE_MS) return;
      this.nativeGaveUp = true;
      this.log(`native UI unavailable, using the panel: ${error.message}`);
      this.render();
      return;
    }
    this.native = bridge;
    try {
      bridge.reconcile();
    } catch (error) {
      this.log(`native sync failed: ${error.stack ?? error.message}`);
    }
    this.render();
  }

  /** Starts a share from what Discord's own Go Live picker returned. */
  async shareFromNative(session, { sourceId, sourceName, sound, resolution, fps }) {
    // Discord's "better readability" preset asks for very low frame rates.
    const mode = fps <= 15 ? "sharp" : "smooth";
    // Without Nitro the picker only offers 720p, but this doesn't run on Discord's servers.
    const hasNitro = Boolean(getCurrentUserPremium());
    const height = resolution === 0 ? 2160 : hasNitro ? resolution : Math.max(resolution, 1080);
    const frameRate = Math.max(fps, 15);
    const width = Math.round((height * 16) / 9);
    const maxBitrate = Math.min(12_000_000, Math.max(1_500_000, Math.round(width * height * frameRate * 0.08)));

    // Electron source ids are "screen:" or "window:". Anything else came from a system
    // picker Electron can't use directly, so ask Electron, which uses the same picker.
    let id = sourceId;
    let name = sourceName;
    if (!/^(screen|window):/.test(id ?? "")) {
      const sources = await listSources();
      if (!sources.length) throw new Error("no capture sources");
      // Wayland's portal returns just what was picked. Anywhere else, never guess.
      id = sources.length === 1 ? sources[0].id : await this.askForSource(sources);
      name = sources.find((source) => source.id === id)?.name;
    }
    const captured = await capture({ sourceId: id, sourceName: name, width, height, fps: frameRate, wantAudio: sound });
    if (captured.audioError) this.log(`audio capture failed: ${captured.audioError}`);
    if (sound && !captured.audio) notify(`Streaming without sound: ${captured.audioError}`);
    await session.startShare({ ...captured, preset: { maxBitrate, fps: frameRate }, label: `${height}p${frameRate}`, mode });
  }

  /**
   * One source, chosen through the system's own picker where there is one. Wayland's
   * portal returns only what was picked. Returns null if the picking was canceled.
   */
  async pickSourceFromSystem() {
    let sources;
    try {
      sources = await listSources();
    } catch (error) {
      this.log(`source listing failed: ${error.message}`);
      return null;
    }
    if (sources.length <= 1) return sources[0] ?? null;
    try {
      const id = await this.askForSource(sources);
      return sources.find((source) => source.id === id) ?? null;
    } catch {
      return null;
    }
  }

  /** Shows the panel's source grid and resolves with the chosen source id. */
  askForSource(sources) {
    return new Promise((resolve, reject) => {
      this.picker = {
        loading: false,
        sources,
        onPick: (id) => { this.picker = null; this.render(); resolve(id); },
        onCancel: () => { this.picker = null; this.render(); reject(new Error("source picking was canceled")); },
      };
      this.render();
    });
  }

  closeSession() {
    this.session?.close().catch((error) => this.log(`close failed: ${error.message}`));
    this.session = null;
  }

  syncChannel() {
    let channelId = null;
    try {
      channelId = getVoiceChannelId();
      this.lookupFailingSince = null;
    } catch (error) {
      // Normal for a few seconds while Discord starts. If it lasts, a Discord
      // update has probably broken the lookup, so say so instead of showing nothing.
      this.lookupFailingSince ??= Date.now();
      if (error.message !== this.lastLookupError) this.log(`voice channel lookup failed: ${error.message}`);
      this.lastLookupError = error.message;
      if (Date.now() - this.lookupFailingSince > LOOKUP_GRACE_MS && !this.error) {
        this.fail("can't detect voice channels", error);
      }
      return;
    }
    if (channelId === this.channelId) return;
    this.channelId = channelId;
    this.error = null;
    this.picker = null;
    this.native?.clearRemoteStreams();
    this.native?.endOwnStream();
    this.closeSession();
    if (channelId) {
      const session = new Session({
        apiUrl: API_URL,
        accessKey: ACCESS_KEY,
        channelId,
        userId: getUserId(),
        displayName: getDisplayName(),
        onChange: () => {
          this.native?.reconcile();
          this.render();
        },
        log: this.log,
      });
      this.session = session;
      session.connect().catch((error) => {
        if (this.session === session) this.fail("connect", error);
      });
    }
    this.render();
  }

  async openPicker() {
    this.error = null;
    this.picker = { loading: true, sources: [] };
    this.render();
    try {
      const sources = await listSources();
      this.log(`capture sources: ${sources.length}`);
      if (!this.picker) return;
      this.picker = { loading: false, sources };
    } catch (error) {
      this.picker = null;
      return this.fail("list sources", error);
    }
    this.render();
  }

  async share(sourceId) {
    const session = this.session;
    if (!session) return;
    const sourceName = this.picker?.sources?.find((source) => source.id === sourceId)?.name;
    this.picker = null;
    this.error = null;
    this.render();
    let captured = null;
    try {
      const preset = QUALITY[this.quality];
      captured = await capture({ sourceId, sourceName, ...preset, wantAudio: this.wantAudio });
      if (captured.audioError) this.log(`audio capture failed: ${captured.audioError}`);
      await session.startShare({ ...captured, preset, label: this.quality, mode: this.mode });
    } catch (error) {
      captured?.video?.stop();
      captured?.audio?.stop();
      this.fail("start share", error);
    }
  }

  statusText() {
    const session = this.session;
    if (!session) return "";
    const state = session.room.state;
    if (state !== "connected") return state;
    return `${session.participantCount()} with plugin`;
  }

  render() {
    if (!this.root) return;
    const session = this.session;
    // With Discord's own UI working, the panel is only for errors and diagnostics.
    const panelNeeded = this.native ? this.debugOpen || Boolean(this.error) || Boolean(this.picker) : Boolean(session) || Boolean(this.error);
    this.root.hidden = !panelNeeded;
    if (!panelNeeded) {
      this.detachMedia();
      this.root.replaceChildren();
      return;
    }
    if (!session) {
      this.detachMedia();
      this.root.replaceChildren();
      if (this.error) {
        this.root.append(el("header", {}, "BYO Stream"), el("div", { className: "body" }, el("div", { className: "error", textContent: this.error })));
      }
      return;
    }

    const watching = this.native ? null : session.watches()[0];
    this.root.classList.toggle("wide", !!watching);

    const header = el("header", { onmousedown: (event) => this.startDrag(event) }, "BYO Stream", el("span", { textContent: this.statusText() }));
    const body = el("div", { className: "body" });

    if (this.error) body.append(el("div", { className: "error", textContent: this.error }));

    const connected = session.room.state === "connected";
    if (this.picker?.onPick) {
      body.append(el("div", { textContent: "Pick what to share:" }), this.renderPicker());
    } else if (this.native) {
      body.append(el("div", { textContent: "Use Discord's normal Share Your Screen button." }));
    } else if (session.publishing) {
      const share = session.publishing;
      const audioNote = share.audioTrack ? "with audio" : `no audio${share.audioError ? ` (${share.audioError})` : ""}`;
      body.append(el("div", { className: "row" },
        el("div", { className: "grow", textContent: `You're live, ${share.quality} ${MODES[share.mode].label.toLowerCase()}, ${audioNote}`, title: audioNote }),
        el("button", { className: "danger", textContent: "Stop", onclick: () => session.stopShare() })));
    } else if (this.picker) {
      body.append(this.renderPicker());
    } else {
      body.append(el("button", { className: "primary", textContent: "Share screen", disabled: !connected, onclick: () => this.openPicker() }));
    }

    for (const streamer of this.native ? [] : session.streamers()) {
      const active = watching?.identity === streamer.identity;
      body.append(el("div", { className: "row" },
        el("div", { className: "grow", textContent: `${streamer.name} is live`, title: streamer.name }),
        el("button", {
          className: active ? "" : "primary",
          textContent: active ? "Close" : "Watch",
          onclick: () => {
            session.watches().forEach((watch) => session.unwatch(watch.identity));
            if (!active) session.watch(streamer.identity);
          },
        })));
    }

    if (watching) body.append(this.renderPlayer(watching));
    body.append(el("div", { className: "stats", textContent: this.statsText }));
    body.append(el("div", { className: "row" }, el("button", { textContent: "Copy diagnostics", onclick: () => this.copyDiagnostics() })));

    this.root.replaceChildren(header, body);
    this.attachMedia(watching);
  }

  renderPicker() {
    const quality = el("select", { onchange: (event) => { this.quality = event.target.value; } },
      ...Object.keys(QUALITY).map((id) => el("option", { value: id, textContent: id, selected: id === this.quality })));
    const mode = el("select", { onchange: (event) => { this.mode = event.target.value; } },
      ...Object.entries(MODES).map(([id, { label }]) => el("option", { value: id, textContent: label, selected: id === this.mode })));
    const audio = el("input", { type: "checkbox", checked: this.wantAudio, onchange: (event) => { this.wantAudio = event.target.checked; } });
    // From Discord's own Go Live flow, quality and audio were already chosen there.
    const fromNative = Boolean(this.picker.onPick);
    const cancel = el("button", { textContent: "Cancel", onclick: () => (fromNative ? this.picker.onCancel() : (this.picker = null, this.render())) });
    const box = el("div", { className: "body", style: "padding:0" },
      fromNative ? el("div", { className: "row" }, cancel) : el("div", { className: "row" }, quality, mode, el("label", {}, audio, " System audio"), cancel));
    if (this.picker.loading) {
      box.append(el("div", { textContent: "Waiting for sources. Your system may ask you to pick a screen." }));
    } else if (!this.picker.sources.length) {
      box.append(el("div", { className: "error", textContent: "No capture sources were returned." }));
    } else {
      box.append(el("div", { className: "sources" }, ...this.picker.sources.map((source) =>
        el("button", { className: "source", onclick: () => (fromNative ? this.picker.onPick(source.id) : this.share(source.id)) },
          el("img", { src: source.url, alt: "" }),
          el("div", { textContent: source.name, title: source.name })))));
    }
    return box;
  }

  renderPlayer(watching) {
    // Rendering replaces the panel's DOM, so these elements are kept and moved.
    if (!this.videoEl) {
      this.videoEl = el("video", { autoplay: true, playsInline: true, muted: true, ondblclick: () => this.videoEl.requestFullscreen() });
      this.audioEl = el("audio", { autoplay: true });
    }
    const volume = el("input", {
      type: "range", min: 0, max: 1, step: 0.05, value: this.volume,
      oninput: (event) => {
        this.volume = Number(event.target.value);
        this.audioEl.volume = this.volume;
      },
    });
    return el("div", { className: "body", style: "padding:0" },
      watching.video ? this.videoEl : el("div", { textContent: "Waiting for video..." }),
      el("div", { className: "row" },
        el("label", {}, "Volume "), volume,
        el("button", { textContent: "Fullscreen", onclick: () => this.videoEl.requestFullscreen() })));
  }

  attachMedia(watching) {
    if (!watching) return this.detachMedia();
    if (watching.video && this.attachedVideo !== watching.video) {
      this.attachedVideo?.detach(this.videoEl);
      watching.video.attach(this.videoEl);
      this.attachedVideo = watching.video;
    }
    if (watching.audio && this.attachedAudio !== watching.audio) {
      this.attachedAudio?.detach(this.audioEl);
      watching.audio.attach(this.audioEl);
      this.audioEl.volume = this.volume;
      this.attachedAudio = watching.audio;
    }
    // Moving an element in the DOM pauses it.
    this.videoEl?.play?.().catch(() => {});
    this.audioEl?.play?.().catch(() => {});
  }

  detachMedia() {
    this.attachedVideo?.detach(this.videoEl);
    this.attachedAudio?.detach(this.audioEl);
    this.attachedVideo = this.attachedAudio = null;
    this.videoEl = this.audioEl = null;
    this.statsData = null;
  }

  async refreshStats() {
    const session = this.session;
    if (!session || this.root?.hidden) return;
    try {
      const sending = await publisherStats(session);
      const receiving = await viewerStats(session);
      this.statsData = { sending, receiving };
      const line = (s) => s && `${s.role} ${s.width}x${s.height} ${s.fps}fps ${s.kbps}kbps ${s.codec} ${s.encoder ?? s.decoder ?? ""}${s.limitedBy && s.limitedBy !== "none" ? ` limited:${s.limitedBy}` : ""}${s.transport ? ` ${s.transport.protocol}` : ""}`;
      this.statsText = [line(sending), line(receiving)].filter(Boolean).join(" | ");
      const node = this.root.querySelector(".stats");
      if (node) node.textContent = this.statsText;
    } catch (error) {
      this.log(`stats failed: ${error.message}`);
    }
  }

  async copyDiagnostics() {
    await navigator.clipboard.writeText(JSON.stringify(await this.report(), null, 1));
    this.log("diagnostics copied");
  }

  /** Plugin state for troubleshooting. Never contains the access key. */
  /** Runs encoder tests on request from the hook (see benchmark.js). */
  async diagnose(request) {
    if (this.benchmarking) return this.log("benchmark already running");
    this.benchmarking = true;
    try {
      await runBenchmark(request, { apiUrl: API_URL, accessKey: ACCESS_KEY, log: this.log });
    } finally {
      this.benchmarking = false;
    }
  }

  async report() {
    const session = this.session;
    const sending = session ? await publisherStats(session).catch(() => null) : null;
    const watching = [];
    for (const watch of session?.watches() ?? []) {
      let inbound = null;
      (await watch.video?.receiver?.getStats().catch(() => null))?.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
      });
      watching.push({
        name: watch.name,
        video: Boolean(watch.video),
        audio: Boolean(watch.audio),
        firstFrameMs: watch.firstFrameMs,
        size: inbound ? `${inbound.frameWidth}x${inbound.frameHeight}` : null,
        fps: inbound ? Math.round(inbound.framesPerSecond ?? 0) : null,
        decoded: inbound?.framesDecoded ?? null,
        dropped: inbound?.framesDropped ?? null,
        decoder: inbound?.decoderImplementation ?? null,
      });
    }
    return {
      sending,
      watching,
      at: new Date().toISOString(),
      version: VERSION,
      native: this.native?.status() ?? (this.nativeGaveUp ? "unavailable, using panel" : "not installed yet"),
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      room: session?.room.state,
      participants: session?.participantCount(),
      publishing: session?.publishing && {
        quality: session.publishing.quality,
        mode: session.publishing.mode,
        codec: session.publishing.videoCodec,
        audio: !!session.publishing.audioTrack,
        audioError: session.publishing.audioError,
      },
      videoCodecs: [...new Set((RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType))],
      stats: this.statsData,
      remote: session ? [...session.room.remoteParticipants.values()].map((p) => ({
        name: p.name,
        hasDiscordId: Boolean(p.attributes?.discordUserId),
        sharing: Boolean(p.getTrackPublication("screen_share")),
      })) : [],
      error: this.error,
      log: this.logs,
    };
  }

  startDrag(event) {
    if (event.button !== 0) return;
    const rect = this.root.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.onDragMove = (move) => {
      this.root.style.left = `${Math.max(0, move.clientX - this.dragOffset.x)}px`;
      this.root.style.top = `${Math.max(0, move.clientY - this.dragOffset.y)}px`;
      this.root.style.right = this.root.style.bottom = "auto";
    };
    this.onDragEnd = () => {
      document.removeEventListener("mousemove", this.onDragMove);
      document.removeEventListener("mouseup", this.onDragEnd);
    };
    document.addEventListener("mousemove", this.onDragMove);
    document.addEventListener("mouseup", this.onDragEnd);
  }
}

// Loaders can run this again on the same page to swap in a new build.
window.__byoStream?.stop();
window.__byoStream = new ByoStream();
window.__byoStream.start();
