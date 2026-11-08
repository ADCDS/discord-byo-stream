// One LiveKit connection for the voice channel the user is currently in.
import { Room, RoomEvent, ScreenSharePresets, Track } from "livekit-client";

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

function pickVideoCodec() {
  const available = (RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType.toLowerCase());
  return ["video/h264", "video/vp9", "video/vp8"].find((c) => available.includes(c))?.split("/")[1] ?? "vp8";
}

export class Session {
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

  /** @param preset { maxBitrate, fps } */
  async startShare({ video, audio, audioError, audioApps, cleanup, preset, label, mode }) {
    const { contentHint, degradationPreference } = MODES[mode];
    const videoCodec = pickVideoCodec();
    video.contentHint = contentHint;
    video.addEventListener("ended", () => {
      this.log("capture ended by the system");
      this.stopShare();
    });
    this.publishing = { videoTrack: video, audioTrack: audio, audioError, audioApps, cleanup, videoCodec, quality: label, mode };
    const local = this.room.localParticipant;
    try {
      this.publishing.videoPublication = await local.publishTrack(video, {
        source: Track.Source.ScreenShare,
        // A light 720p version lets a new viewer start right away, before the
        // server has measured that their connection can take the full stream.
        simulcast: true,
        screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
        videoCodec,
        screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps },
        degradationPreference,
      });
      if (audio) {
        this.publishing.audioPublication = await local.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          audioPreset: { maxBitrate: 128_000 },
          forceStereo: true,
        });
      }
    } catch (error) {
      await this.stopShare();
      throw error;
    }
    const audioNote = audio ? `yes${audioApps ? ` (${audioApps.join(", ") || "nothing playing yet"})` : ""}` : `no (${audioError ?? "not requested"})`;
    this.log(`publishing ${label} ${mode} ${videoCodec}, audio=${audioNote}`);
    this.onChange();
  }

  async stopShare() {
    const share = this.publishing;
    if (!share) return;
    this.publishing = null;
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
