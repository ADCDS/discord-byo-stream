// One LiveKit connection for the voice channel the user is currently in.
import { Room, RoomEvent, Track, VideoPreset } from "livekit-client";
import { encoderInUse, hasHardwareH264, limitedBy, lowLayerSize } from "./encoder.js";

export const QUALITY = {
  "720p30": { width: 1280, height: 720, fps: 30, maxBitrate: 3_000_000 },
  "1080p30": { width: 1920, height: 1080, fps: 30, maxBitrate: 5_000_000 },
  "1080p60": { width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },
};

// The same choice as Go Live's "smoother video" and "better readability".
export const MODES = {
  smooth: { label: "Smoother", contentHint: "motion", degradationPreference: "maintain-framerate" },
  sharp: { label: "Sharper", contentHint: "detail", degradationPreference: "maintain-resolution" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickVideoCodec() {
  const available = (RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType.toLowerCase());
  return ["video/h264", "video/vp9", "video/vp8"].find((c) => available.includes(c))?.split("/")[1] ?? "vp8";
}

export class Session {
  /** The setup that got a hardware encoder, reused for later streams in this Discord session. */
  static hardwareSetup = null;

  constructor({ apiUrl, accessKey, channelId, userId, displayName, onChange, log }) {
    Object.assign(this, { apiUrl, accessKey, channelId, userId, displayName, onChange, log });
    this.room = new Room({ adaptiveStream: false, dynacast: false });
    this.publishing = null;
    this.watched = new Map(); // LiveKit identity -> { identity, name, userId, video, audio }
    this.closed = false;
    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    this.connected.catch(() => {}); // Failures also surface through connect().

    const changed = () => this.onChange();
    for (const event of [
      RoomEvent.ConnectionStateChanged,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.TrackPublished,
    ]) this.room.on(event, changed);

    const participantGone = (participant) => {
      this.unwatch(participant.identity);
      this.onChange();
    };
    this.room.on(RoomEvent.ParticipantDisconnected, participantGone);
    this.room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      if (publication.source === Track.Source.ScreenShare) participantGone(participant);
      else this.onChange();
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const watch = this.watched.get(participant.identity);
      if (!watch) return;
      if (track.kind === Track.Kind.Video) {
        watch.video = track;
        this.timeFirstFrame(watch, track);
      } else {
        watch.audio = track;
      }
      this.onChange();
    });
  }

  async connect() {
    try {
      const response = await fetch(`${this.apiUrl}/token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: this.channelId, userId: this.userId, name: this.displayName }),
      });
      if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
      const { url, token } = await response.json();
      if (this.closed) return;
      await this.room.connect(url, token, { autoSubscribe: false });
      this.log(`connected to ${this.room.name}`);
      this.resolveConnected();
      this.onChange();
    } catch (error) {
      this.rejectConnected(error);
      throw error;
    }
  }

  whenConnected() {
    return this.connected;
  }

  /** Remote participants currently sharing a screen. */
  streamers() {
    return [...this.room.remoteParticipants.values()]
      .filter((p) => p.getTrackPublication(Track.Source.ScreenShare))
      .map((p) => ({ identity: p.identity, name: p.name || p.identity, userId: p.attributes?.discordUserId ?? null }));
  }

  participantCount() {
    return this.room.remoteParticipants.size + 1;
  }

  /** Discord user ids of everyone watching a streamer, from the attributes viewers publish. */
  viewersOf(ownerUserId) {
    const everyone = [this.room.localParticipant, ...this.room.remoteParticipants.values()];
    return everyone
      .filter((p) => (p.attributes?.watching ?? "").split(",").includes(ownerUserId))
      .map((p) => p.attributes?.discordUserId)
      .filter(Boolean);
  }

  /** Logs how long a stream took from Watch to its first decoded frame. */
  async timeFirstFrame(watch, track) {
    const subscribedMs = Math.round(performance.now() - watch.startedAt);
    for (let i = 0; i < 300 && this.watched.get(watch.identity) === watch; i++) {
      let decoded = 0;
      (await track.receiver?.getStats())?.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") decoded = s.framesDecoded ?? 0;
      });
      if (decoded > 0) {
        watch.firstFrameMs = Math.round(performance.now() - watch.startedAt);
        this.log(`watching ${watch.name}: subscribed after ${subscribedMs} ms, first frame after ${watch.firstFrameMs} ms`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.log(`watching ${watch.name}: no frame within 30 s of subscribing`);
  }

  watches() {
    return [...this.watched.values()];
  }

  watch(identity) {
    const participant = this.room.remoteParticipants.get(identity);
    if (!participant || this.watched.has(identity)) return;
    this.watched.set(identity, {
      identity,
      name: participant.name || identity,
      userId: participant.attributes?.discordUserId ?? null,
      video: null,
      audio: null,
      startedAt: performance.now(),
      firstFrameMs: null,
    });
    participant.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(true);
    participant.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(true);
    this.publishWatching();
    this.onChange();
  }

  unwatch(identity) {
    if (!this.watched.delete(identity)) return;
    const participant = this.room.remoteParticipants.get(identity);
    participant?.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(false);
    participant?.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(false);
    this.publishWatching();
    this.onChange();
  }

  publishWatching() {
    if (this.room.state !== "connected") return;
    const watching = this.watches().map((w) => w.userId).filter(Boolean).join(",");
    this.room.localParticipant.setAttributes({ watching }).catch((error) => this.log(`attributes failed: ${error.message}`));
  }

  /**
   * Publishes a capture. Where the computer has a hardware H.264 encoder, checks that
   * the stream really got it, and if not, tries the setups that can: Chromium encodes
   * simulcast layers in software in some cases. Where there's only software encoding
   * and the CPU can't keep up, turns the smaller layer off.
   * @param preset { maxBitrate, fps }
   */
  async startShare({ video, audio, audioError, audioApps, cleanup, preset, label, mode }) {
    const { contentHint, degradationPreference } = MODES[mode];
    const videoCodec = pickVideoCodec();
    video.addEventListener("ended", () => {
      this.log("capture ended by the system");
      this.stopShare();
    });
    this.publishing = { videoTrack: video, audioTrack: audio, audioError, audioApps, cleanup, videoCodec, quality: label, mode };
    const share = this.publishing;
    const local = this.room.localParticipant;
    try {
      const size = await Promise.race([video.frameSize ?? Promise.resolve(null), sleep(3000).then(() => null)]);
      const hardware = videoCodec === "h264" && size
        ? await hasHardwareH264({ width: size.width, height: size.height, fps: preset.fps, bitrate: preset.maxBitrate })
        : false;
      const sizeNote = size ? `${size.width}x${size.height}` : "unknown size";
      this.log(`hardware ${videoCodec} encoder for ${sizeNote}: ${hardware === null ? "unknown" : hardware ? "yes" : "no"}`);

      // A smaller layer lets new viewers start right away, before the server has
      // measured that their connection can take the full stream.
      const attempts = [{ simulcast: true, hint: contentHint }];
      if (hardware) {
        attempts.push({ simulcast: false, hint: contentHint });
        // Chromium may send screen content ("detail") to the software encoder.
        if (contentHint !== "motion") attempts.push({ simulcast: false, hint: "motion" });
      }
      // Within one Discord session, start from what worked last time.
      const known = attempts.findIndex((a) => a.simulcast === Session.hardwareSetup?.simulcast && a.hint === Session.hardwareSetup?.hint);
      if (known > 0) attempts.unshift(...attempts.splice(known, 1));

      const publishAudio = async () => {
        if (!audio || share.audioPublication || this.publishing !== share) return;
        share.audioPublication = await local.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          audioPreset: { maxBitrate: 128_000 },
          forceStereo: true,
        });
      };
      for (const [index, attempt] of attempts.entries()) {
        video.contentHint = attempt.hint;
        share.videoPublication = await local.publishTrack(video, {
          source: Track.Source.ScreenShare,
          simulcast: attempt.simulcast && Boolean(size),
          screenShareSimulcastLayers: attempt.simulcast && size
            ? [new VideoPreset(lowLayerSize(size).width, lowLayerSize(size).height, 1_500_000, 15)]
            : undefined,
          videoCodec,
          screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps },
          degradationPreference,
        });
        share.simulcast = attempt.simulcast && Boolean(size);
        // Sound doesn't depend on how the video is encoded, so it starts right away.
        await publishAudio();
        const used = await encoderInUse(share.videoPublication.track.sender);
        share.encoder = used;
        const setup = `${attempt.simulcast ? "two layers" : "one layer"}, content ${attempt.hint}`;
        this.log(`encoder with ${setup}: ${used ? `${used.implementation}${used.hardware ? " (hardware)" : " (software)"}` : "not reported"}`);
        if (!hardware || used?.hardware || index === attempts.length - 1) {
          if (used?.hardware) Session.hardwareSetup = attempt;
          break;
        }
        if (this.publishing !== share) return;
        await local.unpublishTrack(video, false);
      }
      if (this.publishing !== share) return;
    } catch (error) {
      await this.stopShare();
      throw error;
    }
    if (!share.encoder?.hardware && share.simulcast) this.relieveCpu(share);
    const audioNote = audio ? `yes${audioApps ? ` (${audioApps.join(", ") || "nothing playing yet"})` : ""}` : `no (${audioError ?? "not requested"})`;
    const encoderNote = share.encoder ? `${share.encoder.hardware ? "hardware" : "software"} ${share.encoder.implementation}` : "encoder unknown";
    this.log(`publishing ${label} ${mode} ${videoCodec}, ${share.simulcast ? "two layers" : "one layer"}, ${encoderNote}, audio=${audioNote}`);
    this.onChange();
  }

  /**
   * With software encoding, a busy CPU makes WebRTC shrink the picture. Encoding the
   * smaller layer too costs about a third more, so turn it off once the CPU has been
   * the limit for a few seconds. Viewers then all get the full layer.
   */
  relieveCpu(share) {
    let strikes = 0;
    share.cpuTimer = setInterval(async () => {
      const sender = share.videoPublication?.track?.sender;
      if (this.publishing !== share || !sender) return clearInterval(share.cpuTimer);
      const reason = await limitedBy(sender).catch(() => null);
      strikes = reason === "cpu" ? strikes + 1 : 0;
      if (strikes < 3) return;
      const params = sender.getParameters();
      const low = params.encodings.find((encoding) => encoding.rid === "q");
      if (!low || low.active === false || params.encodings.length < 2) return;
      low.active = false;
      try {
        await sender.setParameters(params);
        this.log("the CPU can't keep up: turned off the stream's smaller layer");
      } catch (error) {
        this.log(`couldn't turn off the smaller layer: ${error.message}`);
      }
      strikes = 0;
    }, 2000);
  }

  async stopShare() {
    const share = this.publishing;
    if (!share) return;
    this.publishing = null;
    clearInterval(share.cpuTimer);
    share.cleanup?.();
    const local = this.room.localParticipant;
    for (const track of [share.videoTrack, share.audioTrack]) {
      if (!track) continue;
      await local.unpublishTrack(track, true).catch((error) => this.log(`unpublish failed: ${error.message}`));
      track.stop();
    }
    this.onChange();
  }

  async close() {
    this.closed = true;
    await this.stopShare();
    await this.room.disconnect();
  }
}
