// Makes Discord's own Go Live UI (share button, picker, LIVE badge, stream tile,
// viewers) drive our LiveKit stream. Streams are marked active with STREAM_UPDATE,
// not STREAM_CREATE: Discord's StreamRTCConnectionStore assumes a STREAM_CREATE
// always comes with a real media server and throws without one. Discord still believes it runs a normal Go Live,
// but nothing about it reaches Discord: gateway calls are dropped, and the states its
// servers would normally send back are dispatched locally instead.
import { findExport, getStore } from "./discord.js";

const STREAM_ID_PREFIX = "vcstream:";
const VIDEO_GUARD_EXPERIMENT = "2026-08-video-guard";
const REGION = "vcstream";
const STREAM_CONTEXT = "stream";
const GATEWAY_STREAM_METHODS = ["streamCreate", "streamWatch", "streamDelete", "streamSetPaused", "streamPing"];
const REASON_USER_REQUESTED = "user_requested";
const REASON_UNAUTHORIZED = "unauthorized";

function streamKeyOf({ streamType, guildId, channelId, ownerId }) {
  return streamType === "guild" ? ["guild", guildId, channelId, ownerId].join(":") : ["call", channelId, ownerId].join(":");
}

function parseStreamKey(key) {
  const parts = key.split(":");
  return parts[0] === "guild"
    ? { streamType: "guild", guildId: parts[1], channelId: parts[2], ownerId: parts[3] }
    : { streamType: "call", guildId: null, channelId: parts[1], ownerId: parts[2] };
}

/** Finds everything the bridge needs. Throws naming the first piece that's missing. */
function locate() {
  const need = (name, value) => {
    if (!value) throw new Error(`${name} not found`);
    return value;
  };
  return {
    dispatcher: need("dispatcher", findExport((v) => typeof v.addInterceptor === "function" && Array.isArray(v._interceptors))),
    guard: need("video guard", findExport((v) => v.definition?.name === VIDEO_GUARD_EXPERIMENT && typeof v.getConfig === "function")),
    // Lazy proxies also expose createElement-like members; only real React marks Component.
    React: need("React", findExport((v) => typeof v.createElement === "function" && Boolean(v.Component?.prototype?.isReactComponent))),
    mediaEngine: need("MediaEngineStore", getStore("MediaEngineStore")),
    gateway: need("GatewayConnectionStore", getStore("GatewayConnectionStore")),
    voiceStates: need("VoiceStateStore", getStore("VoiceStateStore")),
    streaming: need("ApplicationStreamingStore", getStore("ApplicationStreamingStore")),
    previews: need("ApplicationStreamPreviewStore", getStore("ApplicationStreamPreviewStore")),
    users: need("UserStore", getStore("UserStore")),
  };
}

export class NativeBridge {
  constructor({ getSession, startCapture, pickSource, log }) {
    Object.assign(this, { getSession, startCapture, pickSource, log });
    this.pickedSource = null; // { id, name } from our system picker, until a stream uses it
    this.liveUsers = new Map(); // Discord user id -> LiveKit identity, for remote streamers
    this.watchedKeys = new Map(); // stream key -> owner user id
    this.own = null; // { key, guildId, channelId, source, started }
    this.viewerSignatures = new Map();
    this.audioEls = new Map();
    this.videoListeners = new Set();
    this.undo = [];
  }

  /** Returns true once installed. Throws, leaving nothing patched, if any step fails. */
  install() {
    try {
      return this.installSteps();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  installSteps() {
    const parts = locate();
    Object.assign(this, parts);
    this.selfId = () => this.users.getCurrentUser()?.id;

    this.patch(this.guard, "getConfig", (original) => (...args) => ({ ...original(...args), videoEnabled: true }));
    this.patch(this.guard, "useConfig", (original) => (...args) => ({ ...original(...args), videoEnabled: true }));

    const socket = this.gateway.getSocket();
    for (const method of GATEWAY_STREAM_METHODS) {
      this.patch(socket, method, () => (...args) => this.log(`blocked gateway ${method} ${args[0] ?? ""}`));
    }

    this.videoComponent = this.createVideoComponent();
    const originalComponent = this.mediaEngine.getVideoComponent.bind(this.mediaEngine);
    this.patch(this.mediaEngine, "getVideoComponent", () => () => {
      this.fallbackComponent = originalComponent();
      return this.videoComponent;
    });
    this.patch(this.previews, "shouldFetchPreview", () => () => false);

    // Discord's system picker runs in its native engine and hands back a token that
    // Chromium can't capture, so using it as-is meant picking twice.
    const engine = this.mediaEngine.getMediaEngine();
    if (navigator.platform.startsWith("Linux")) {
      // On Wayland the system picker is the desktop portal, and Discord shows it with
      // no window of its own. Keep that flow, but open the portal through Chromium
      // and report the pick the way the native engine would.
      this.patch(engine, "presentNativeScreenSharePicker", () => () => {
        this.presentSystemPicker().catch((error) => this.log(`picker failed: ${error.message}`));
      });
      this.patch(engine, "setNativeDesktopVideoSourcePickerActive", () => () => {});
      this.patch(engine, "releaseNativeDesktopVideoSourcePickerStream", () => () => {});
    } else {
      // On macOS the system picker isn't reachable from Chromium, so use Discord's own
      // source window, fed from Chromium's sources: one pick, with ids we can capture.
      this.patch(this.mediaEngine, "getUseSystemScreensharePicker", () => () => false);
      this.patch(this.mediaEngine, "supportsSystemScreensharePicker", () => () => false);
      this.patch(engine, "supports", (original) => (feature) =>
        feature === "SCREEN_PREVIEWS" || feature === "WINDOW_PREVIEWS" ? false : original(feature));
    }

    const interceptor = (action) => this.onAction(action);
    this.dispatcher.addInterceptor(interceptor);
    this.undo.push(() => {
      const index = this.dispatcher._interceptors.indexOf(interceptor);
      if (index >= 0) this.dispatcher._interceptors.splice(index, 1);
    });

    const onEngineChange = () => this.applyVolumes();
    this.mediaEngine.addChangeListener(onEngineChange);
    this.undo.push(() => this.mediaEngine.removeChangeListener(onEngineChange));

    this.mediaEngine.emitChange();
    this.log("native UI bridge installed");
    return true;
  }

  uninstall() {
    if (this.undo.length) {
      this.clearRemoteStreams();
      this.endOwnStream();
    }
    this.rollback();
    this.mediaEngine?.emitChange();
  }

  rollback() {
    for (const undo of this.undo.reverse()) {
      try {
        undo();
      } catch (error) {
        this.log(`undo failed: ${error.message}`);
      }
    }
    this.undo = [];
  }

  /** Overrides a method for as long as the bridge is installed. */
  patch(target, name, makeReplacement) {
    const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
    const previous = target[name];
    target[name] = makeReplacement(previous.bind(target));
    this.undo.push(() => {
      if (hadOwn) target[name] = previous;
      else delete target[name];
    });
  }

  dispatch(action) {
    Promise.resolve(this.dispatcher.dispatch(action)).catch((error) => this.log(`dispatch ${action.type} failed: ${error.message}`));
  }

  /** Runs before Discord handles any action. Returning true drops the action. */
  onAction(action) {
    switch (action.type) {
      case "MEDIA_ENGINE_SET_GO_LIVE_SOURCE":
        return this.onGoLiveSource(action);
      case "MEDIA_ENGINE_SET_VIDEO_ENABLED":
        // The native camera would send video to Discord's servers.
        if (action.enabled) this.log("camera isn't supported, ignoring");
        return Boolean(action.enabled);
      case "STREAM_START":
        this.onStreamStart(action);
        return false;
      case "STREAM_WATCH":
        this.onStreamWatch(action);
        return false;
      case "STREAM_STOP":
        this.onStreamStop(action);
        return false;
      case "VOICE_STATE_UPDATES":
        // Discord's servers don't know about these streams and would clear the flag.
        for (const state of action.voiceStates) {
          if (state.channelId && this.isLive(state.userId)) state.selfStream = true;
        }
        return false;
      default:
        return false;
    }
  }

  isLive(userId) {
    return this.liveUsers.has(userId) || (userId === this.selfId() && Boolean(this.own?.started));
  }

  // ---- Streaming ----

  /** Shows the system picker through Chromium and reports the result like Discord's engine. */
  async presentSystemPicker() {
    const existing = Boolean(this.own?.started);
    const source = await this.pickSource();
    if (!source) {
      this.dispatch({ type: "NATIVE_SCREEN_SHARE_PICKER_CANCEL", existing });
      return;
    }
    this.pickedSource = source;
    const isWindow = source.id.startsWith("window:");
    const content = { windows: isWindow ? [{ title: source.name }] : [], applications: [], displays: isWindow ? [] : [{ name: source.name }] };
    this.log(`system picker chose ${source.id} "${source.name ?? ""}"`);
    if (existing && this.lastSource) {
      // Switching what's shared mid-stream.
      this.pendingSource = { ...this.lastSource, sourceId: source.id };
      this.pickedSource = null;
      this.beginIfReady();
    }
    // Discord starts the stream itself when it sees a fresh pick.
    this.dispatch({ type: "NATIVE_SCREEN_SHARE_PICKER_UPDATE", existing, content });
  }

  onGoLiveSource({ settings }) {
    if (!settings?.desktopSettings) {
      if (settings?.cameraSettings) this.log("camera as a stream source isn't supported");
      return true; // Never start the native capture engine.
    }
    let sourceId = settings.desktopSettings.sourceId;
    let sourceName = null;
    if (sourceId?.startsWith("prepicked:") && this.pickedSource) {
      ({ id: sourceId, name: sourceName } = this.pickedSource);
      this.pickedSource = null;
    }
    this.pendingSource = {
      sourceId,
      sourceName,
      sound: Boolean(settings.desktopSettings.sound),
      resolution: settings.qualityOptions?.resolution ?? 1080,
      fps: settings.qualityOptions?.frameRate ?? 30,
    };
    // Discord re-sends the same source right after a stream starts.
    const current = this.startingSource ?? this.activeSource;
    if (current && current.sourceId === this.pendingSource.sourceId && current.sound === this.pendingSource.sound) {
      this.pendingSource = null;
      return true;
    }
    this.lastSource = this.pendingSource;
    this.log(`go live source ${this.pendingSource.sourceId} ${this.pendingSource.resolution}p${this.pendingSource.fps} sound=${this.pendingSource.sound}`);
    this.beginIfReady();
    return true;
  }

  onStreamStart({ streamType, guildId, channelId }) {
    const ownerId = this.selfId();
    this.own = { key: streamKeyOf({ streamType, guildId, channelId, ownerId }), guildId: guildId ?? null, channelId, started: false };
    this.beginIfReady();
  }

  /** Starts or switches the capture. One at a time; a newer request waits its turn. */
  beginIfReady() {
    if (!this.own || !this.pendingSource || this.starting) return;
    const source = this.pendingSource;
    this.pendingSource = null;
    this.starting = true;
    this.startSharing(source)
      .then(() => {
        this.activeSource = source;
      })
      .catch((error) => {
        this.log(`stream failed: ${error.name}: ${error.message}`);
        const key = this.own?.key;
        this.own = null;
        if (key) this.dispatch({ type: "STREAM_DELETE", streamKey: key, unavailable: false, reason: REASON_UNAUTHORIZED });
      })
      .finally(() => {
        this.starting = false;
        this.beginIfReady();
      });
  }

  async startSharing(source) {
    this.startingSource = source;
    try {
      await this.startSharingNow(source);
    } finally {
      this.startingSource = null;
    }
  }

  async startSharingNow(source) {
    const session = this.getSession();
    if (!session) throw new Error("not connected to a voice channel");
    await session.whenConnected();
    const wasLive = this.own.started;
    if (session.publishing) await session.stopShare();
    await this.startCapture(session, source);
    const { key, guildId } = this.own;
    this.own.started = true;
    this.dispatch({ type: "STREAM_UPDATE", streamKey: key, region: REGION, viewerIds: [], paused: false });
    if (!wasLive) this.setVoiceStateStream(this.selfId(), true);
    this.dispatch({ type: "RTC_CONNECTION_VIDEO", userId: this.selfId(), guildId, streamId: `${STREAM_ID_PREFIX}${this.selfId()}`, context: STREAM_CONTEXT });
    this.notifyVideoListeners();
  }

  onStreamStop({ streamKey }) {
    if (streamKey === this.own?.key) {
      this.endOwnStream();
    } else if (parseStreamKey(streamKey).ownerId === this.selfId()) {
      // A stream of ours the bridge lost track of, e.g. after a plugin update.
      this.getSession()?.stopShare().catch(() => {});
      this.setVoiceStateStream(this.selfId(), false);
      this.dispatch({ type: "STREAM_DELETE", streamKey, unavailable: false, reason: REASON_USER_REQUESTED });
    } else if (this.watchedKeys.has(streamKey)) {
      const ownerId = this.watchedKeys.get(streamKey);
      this.watchedKeys.delete(streamKey);
      const identity = this.liveUsers.get(ownerId);
      if (identity) this.getSession()?.unwatch(identity);
      this.closeRemoteStream(streamKey, ownerId);
    }
  }

  endOwnStream() {
    const own = this.own;
    if (!own) return;
    this.own = null;
    this.pendingSource = null;
    this.activeSource = null;
    this.getSession()?.stopShare().catch((error) => this.log(`stop failed: ${error.message}`));
    if (!own.started || !this.dispatcher) return;
    this.setVoiceStateStream(this.selfId(), false);
    this.dispatch({ type: "RTC_CONNECTION_VIDEO", userId: this.selfId(), guildId: own.guildId, streamId: null, context: STREAM_CONTEXT });
    this.dispatch({ type: "STREAM_DELETE", streamKey: own.key, unavailable: false, reason: REASON_USER_REQUESTED });
  }

  // ---- Watching ----

  onStreamWatch({ streamKey }) {
    const { ownerId, guildId } = parseStreamKey(streamKey);
    if (ownerId === this.selfId()) {
      // Discord's own preview of your stream: there's nothing to subscribe to.
      this.dispatch({ type: "STREAM_UPDATE", streamKey, region: REGION, viewerIds: this.viewerIdsFor(ownerId), paused: false });
      this.dispatch({ type: "RTC_CONNECTION_VIDEO", userId: ownerId, guildId, streamId: `${STREAM_ID_PREFIX}${ownerId}`, context: STREAM_CONTEXT });
      return;
    }
    const identity = this.liveUsers.get(ownerId);
    this.log(`watch requested for ${ownerId}${identity ? "" : " (not live on VCStream)"}`);
    if (!identity) {
      this.log(`watch: ${ownerId} isn't live on VCStream`);
      this.dispatch({ type: "STREAM_DELETE", streamKey, unavailable: false, reason: REASON_UNAUTHORIZED });
      return;
    }
    this.watchedKeys.set(streamKey, ownerId);
    this.getSession()?.watch(identity);
    this.dispatch({ type: "STREAM_UPDATE", streamKey, region: REGION, viewerIds: this.viewerIdsFor(ownerId), paused: false });
    this.dispatch({ type: "RTC_CONNECTION_VIDEO", userId: ownerId, guildId, streamId: `${STREAM_ID_PREFIX}${ownerId}`, context: STREAM_CONTEXT });
  }

  closeRemoteStream(streamKey, ownerId, reason = REASON_USER_REQUESTED) {
    const { guildId } = parseStreamKey(streamKey);
    this.dispatch({ type: "RTC_CONNECTION_VIDEO", userId: ownerId, guildId, streamId: null, context: STREAM_CONTEXT });
    this.dispatch({ type: "STREAM_DELETE", streamKey, unavailable: false, reason });
    this.notifyVideoListeners();
  }

  viewerIdsFor(ownerId) {
    return this.getSession()?.viewersOf(ownerId) ?? [];
  }

  // ---- Keeping Discord's state in step with the LiveKit room ----

  /** Called whenever the room changes. */
  reconcile() {
    if (!this.dispatcher) return;
    const session = this.getSession();
    const streamers = session?.streamers() ?? [];
    const current = new Map(streamers.filter((s) => s.userId).map((s) => [s.userId, s.identity]));

    for (const [userId, identity] of current) {
      if (this.liveUsers.get(userId) === identity) continue;
      this.liveUsers.set(userId, identity);
      const shown = this.setVoiceStateStream(userId, true);
      this.log(`${identity} went live${shown ? "" : ", but they have no voice state in this channel here"}`);
    }
    const unmapped = streamers.filter((s) => !s.userId).map((s) => s.identity);
    if (unmapped.join() !== this.lastUnmapped) {
      this.lastUnmapped = unmapped.join();
      if (unmapped.length) this.log(`live without a Discord id, can't show: ${this.lastUnmapped}`);
    }
    for (const userId of [...this.liveUsers.keys()]) {
      if (current.has(userId)) continue;
      this.liveUsers.delete(userId);
      this.setVoiceStateStream(userId, false);
      for (const [key, ownerId] of [...this.watchedKeys]) {
        if (ownerId !== userId) continue;
        this.watchedKeys.delete(key);
        this.closeRemoteStream(key, ownerId);
      }
    }

    // The capture was ended outside Discord's UI, e.g. the shared window closed.
    if (this.own?.started && session && !session.publishing) this.endOwnStream();

    this.syncViewers();
    this.syncAudio();
    this.notifyVideoListeners();
  }

  clearRemoteStreams() {
    for (const [key, ownerId] of [...this.watchedKeys]) this.closeRemoteStream(key, ownerId);
    this.watchedKeys.clear();
    for (const userId of [...this.liveUsers.keys()]) {
      this.liveUsers.delete(userId);
      this.setVoiceStateStream(userId, false);
    }
    this.viewerSignatures.clear();
    this.syncAudio();
  }

  syncViewers() {
    const streams = [...this.watchedKeys.entries()].map(([key, ownerId]) => [key, ownerId]);
    if (this.own?.started) streams.push([this.own.key, this.selfId()]);
    for (const [key, ownerId] of streams) {
      const viewerIds = this.viewerIdsFor(ownerId);
      const signature = viewerIds.join(",");
      if (this.viewerSignatures.get(key) === signature) continue;
      this.viewerSignatures.set(key, signature);
      this.dispatch({ type: "STREAM_UPDATE", streamKey: key, region: REGION, viewerIds, paused: false });
    }
  }

  setVoiceStateStream(userId, live) {
    const session = this.getSession();
    const channelId = session?.channelId ?? this.own?.channelId;
    const state = channelId ? this.voiceStates.getVoiceStateForChannel(channelId, userId) : null;
    if (!state) return false;
    const guildId = this.findGuildId(channelId);
    this.dispatch({
      type: "VOICE_STATE_UPDATES",
      voiceStates: [{
        userId,
        guildId,
        channelId,
        sessionId: state.sessionId,
        mute: state.mute,
        deaf: state.deaf,
        selfMute: state.selfMute,
        selfDeaf: state.selfDeaf,
        selfVideo: state.selfVideo,
        selfStream: live,
        suppress: state.suppress,
        requestToSpeakTimestamp: state.requestToSpeakTimestamp,
      }],
    });
    return true;
  }

  findGuildId(channelId) {
    return getStore("ChannelStore")?.getChannel(channelId)?.getGuildId?.() ?? null;
  }

  // ---- Stream audio ----

  syncAudio() {
    const watches = this.getSession()?.watches() ?? [];
    const wanted = new Map(watches.filter((w) => w.audio).map((w) => [w.identity, w]));
    for (const [identity, audio] of [...this.audioEls]) {
      if (wanted.get(identity)?.audio.mediaStreamTrack === audio.srcObject?.getTracks()[0]) continue;
      audio.srcObject = null;
      audio.remove();
      this.audioEls.delete(identity);
    }
    for (const [identity, watch] of wanted) {
      if (this.audioEls.has(identity)) continue;
      const audio = Object.assign(document.createElement("audio"), { autoplay: true, srcObject: new MediaStream([watch.audio.mediaStreamTrack]) });
      audio.dataset.owner = watch.userId ?? "";
      document.body.append(audio);
      this.audioEls.set(identity, audio);
    }
    this.applyVolumes();
  }

  /** Applies Discord's own per-stream volume and mute settings, and deafen. */
  applyVolumes() {
    for (const audio of this.audioEls.values()) {
      const owner = audio.dataset.owner;
      const volume = owner ? this.mediaEngine.getLocalVolume(owner, STREAM_CONTEXT) : 100;
      audio.volume = Math.min(1, Math.max(0, (volume ?? 100) / 100));
      audio.muted = this.mediaEngine.isSelfDeaf() || (Boolean(owner) && this.mediaEngine.isLocalMute(owner, STREAM_CONTEXT));
    }
  }

  // ---- Video: what Discord's tiles render ----

  trackForStreamId(streamId) {
    const userId = streamId.slice(STREAM_ID_PREFIX.length);
    const session = this.getSession();
    if (userId === this.selfId()) return session?.publishing?.videoTrack ?? null;
    return session?.watches().find((w) => w.userId === userId)?.video?.mediaStreamTrack ?? null;
  }

  notifyVideoListeners() {
    for (const listener of this.videoListeners) listener();
  }

  createVideoComponent() {
    const bridge = this;
    const { Component, createElement } = this.React;

    // Discord passes { className, streamId, onResize, onReady, paused }.
    class LiveVideo extends Component {
      video = null;

      setVideo = (element) => {
        this.video = element;
        this.attach();
      };

      attach = () => {
        const video = this.video;
        if (!video) return;
        const track = bridge.trackForStreamId(this.props.streamId);
        if (track === this.track) return;
        this.track = track;
        video.srcObject = track ? new MediaStream([track]) : null;
        if (track) video.play().catch(() => {});
      };

      componentDidMount() {
        bridge.videoListeners.add(this.attach);
      }

      componentDidUpdate() {
        this.attach();
        if (!this.video) return;
        if (this.props.paused) this.video.pause();
        else if (this.video.paused && this.track) this.video.play().catch(() => {});
      }

      componentWillUnmount() {
        bridge.videoListeners.delete(this.attach);
      }

      render() {
        const { className, onReady, onResize } = this.props;
        return createElement("video", {
          ref: this.setVideo,
          className,
          autoPlay: true,
          playsInline: true,
          muted: true,
          onLoadedData: () => onReady?.(),
          onResize: (event) => onResize?.({ width: event.target.videoWidth, height: event.target.videoHeight }),
        });
      }
    }

    return function VCStreamVideo(props) {
      if (String(props.streamId).startsWith(STREAM_ID_PREFIX)) return createElement(LiveVideo, props);
      return bridge.fallbackComponent ? createElement(bridge.fallbackComponent, props) : null;
    };
  }

  status() {
    return {
      installed: this.undo.length > 0,
      own: this.own && { key: this.own.key, started: this.own.started },
      live: [...this.liveUsers.keys()],
      watching: [...this.watchedKeys.keys()],
    };
  }
}
