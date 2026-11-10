// An encoder test that runs inside Discord on request, without a restart: the hook
// passes it the contents of diagnose.json from BYO Stream's data folder (which only
// the user's own account can write). Each test publishes a synthetic moving picture
// to a throwaway LiveKit room for a few seconds, then logs which encoder WebRTC used,
// whether it was hardware, and what limited it. Nothing is captured from the screen.
import { Room, Track, VideoPreset } from "livekit-client";
import { installHardwareH264, withOurConnections } from "./h264-hardware.js";

const CODECS = ["h264", "h265", "vp8", "vp9", "av1"];
const HINTS = ["motion", "detail", ""];
const MAX_TESTS = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function syntheticTrack(width, height) {
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const g = canvas.getContext("2d");
  const timer = setInterval(() => {
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${Math.random() * 360} 80% 50%)`;
      g.fillRect(Math.random() * width, Math.random() * height, width / 20, height / 20);
    }
  }, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  return { track, stop: () => { clearInterval(timer); track.stop(); } };
}

/**
 * Leaves only the H.264 variants whose fmtp contains `fmtp` in an offer's video
 * sections (plus their RTX), so the server has to pick one of them.
 */
export function keepH264Variants(sdp, fmtp) {
  const sections = sdp.split(/(?=^m=)/m);
  return sections.map((section) => {
    if (!section.startsWith("m=video")) return section;
    const rtpmap = [...section.matchAll(/^a=rtpmap:(\d+) ([^/\s]+)\//gm)].map((m) => ({ pt: m[1], name: m[2].toLowerCase() }));
    const fmtpOf = (pt) => section.match(new RegExp(`^a=fmtp:${pt} (.*)$`, "m"))?.[1] ?? "";
    const h264 = rtpmap.filter((c) => c.name === "h264");
    const keep = h264.filter((c) => fmtpOf(c.pt).includes(fmtp)).map((c) => c.pt);
    if (!keep.length) return section;
    const drop = new Set(h264.map((c) => c.pt).filter((pt) => !keep.includes(pt)));
    for (const c of rtpmap) {
      const apt = fmtpOf(c.pt).match(/apt=(\d+)/)?.[1];
      if (c.name === "rtx" && apt && drop.has(apt)) drop.add(c.pt);
    }
    return section
      .replace(/^(m=video \S+ \S+)((?: \d+)+)/m, (_, head, pts) => head + pts.split(" ").filter((pt) => pt && !drop.has(pt)).map((pt) => ` ${pt}`).join(""))
      .split(/\r?\n/)
      .filter((line) => !/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/.test(line) || !drop.has(line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/)[1]))
      .join("\r\n");
  }).join("");
}

/**
 * While a test sets up, marks the peer connections LiveKit creates, and rewrites only
 * their offers to the wanted H.264 variant. Discord's and the live stream's own
 * connections are left alone.
 */
function preferFmtp(fmtp) {
  if (!fmtp) return { done: () => {}, stop: () => {} };
  const Native = window.RTCPeerConnection;
  const createOffer = Native.prototype.createOffer;
  const Marked = function (...args) {
    const pc = new Native(...args);
    pc.byoBenchmark = true;
    return pc;
  };
  Marked.prototype = Native.prototype;
  Object.setPrototypeOf(Marked, Native);
  window.RTCPeerConnection = Marked;
  Native.prototype.createOffer = async function (...args) {
    const offer = await createOffer.apply(this, args);
    if (!this.byoBenchmark) return offer;
    return { type: offer.type, sdp: keepH264Variants(offer.sdp, fmtp) };
  };
  return {
    done: () => { window.RTCPeerConnection = Native; }, // new connections: unmarked again
    stop: () => { window.RTCPeerConnection = Native; Native.prototype.createOffer = createOffer; },
  };
}

function clean(test) {
  const n = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  return {
    codec: CODECS.includes(test.codec) ? test.codec : "h264",
    simulcast: test.simulcast === true,
    hint: HINTS.includes(test.hint) ? test.hint : "motion",
    fmtp: typeof test.fmtp === "string" ? test.fmtp.replace(/[^a-z0-9=;-]/gi, "").slice(0, 60) : "",
    baseline: test.baseline === true, // Baseline H.264 sent as Constrained Baseline, as h264-hardware.js does
    width: n(test.width, 160, 3840, 1600) & ~7,
    height: n(test.height, 120, 2160, 1072) & ~7,
    seconds: n(test.seconds, 2, 10, 5),
    bitrate: n(test.bitrate, 200_000, 12_000_000, 5_000_000),
  };
}

async function runOne(test, { apiUrl, accessKey, log }) {
  const channelId = `1${Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join("")}`;
  const response = await fetch(`${apiUrl}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, name: "encoder test" }),
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  const { url, token } = await response.json();
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const source = syntheticTrack(test.width, test.height);
  const preference = preferFmtp(test.fmtp);
  try {
    if (test.baseline) {
      installHardwareH264();
      await withOurConnections(() => room.connect(url, token, { autoSubscribe: false }));
    } else {
      await room.connect(url, token, { autoSubscribe: false });
    }
    source.track.contentHint = test.hint;
    const publication = await room.localParticipant.publishTrack(source.track, {
      source: Track.Source.ScreenShare,
      simulcast: test.simulcast,
      screenShareSimulcastLayers: test.simulcast ? [new VideoPreset(test.width / 2, test.height / 2, 1_500_000, 15)] : undefined,
      videoCodec: test.codec,
      screenShareEncoding: { maxBitrate: test.bitrate, maxFramerate: 30 },
      degradationPreference: "maintain-framerate",
    });
    preference.done();
    await sleep(test.seconds * 1000);
    const report = await publication.track.sender.getStats();
    const layers = [];
    report.forEach((s) => {
      if (s.type !== "outbound-rtp" || s.kind !== "video") return;
      const codec = report.get(s.codecId);
      layers.push({
        rid: s.rid,
        size: `${s.frameWidth}x${s.frameHeight}`,
        fps: Math.round(s.framesPerSecond ?? 0),
        encoder: s.encoderImplementation,
        hardware: s.powerEfficientEncoder,
        limitedBy: s.qualityLimitationReason,
        codec: codec ? `${codec.mimeType} ${codec.sdpFmtpLine ?? ""}`.trim() : null,
      });
    });
    log(`benchmark ${JSON.stringify({ test, layers })}`);
  } finally {
    preference.stop();
    source.stop();
    await room.disconnect();
  }
}

/** Runs the tests in request.tests one after another and logs each result. */
export async function runBenchmark(request, context) {
  const tests = (Array.isArray(request?.tests) ? request.tests : []).slice(0, MAX_TESTS).map(clean);
  context.log(`benchmark: ${tests.length} tests`);
  const formats = (RTCRtpSender.getCapabilities("video")?.codecs ?? [])
    .filter((c) => /H264|H265/i.test(c.mimeType))
    .map((c) => `${c.mimeType.split("/")[1]} ${c.sdpFmtpLine ?? ""}`);
  context.log(`benchmark: send formats ${JSON.stringify(formats)}`);
  for (const test of tests) {
    try {
      await runOne(test, context);
    } catch (error) {
      context.log(`benchmark ${JSON.stringify(test)} failed: ${error.message}`);
    }
    await sleep(500);
  }
  context.log("benchmark: done");
}
