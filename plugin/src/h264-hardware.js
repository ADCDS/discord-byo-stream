// Hardware H.264 through LiveKit, where Chromium only offers it as Baseline.
//
// On a Mac, Chromium hands WebRTC the hardware H.264 encoder (VideoToolbox) for the
// Baseline (42001f) and Main profiles, but not for Constrained Baseline (42e01f).
// LiveKit only accepts Constrained Baseline, so streams get Chromium's software
// encoder, which a busy laptop can't keep up with.
//
// A hardware encoder's Baseline stream uses none of the tools that set Baseline apart
// from Constrained Baseline, so any decoder of one decodes the other. So for our own
// connection only, the offer sent to LiveKit presents the Baseline format as
// Constrained Baseline, and LiveKit's answer is read back as Baseline. Chromium then
// encodes Baseline in hardware, and LiveKit forwards it as usual.

const CONSTRAINED_BASELINE = "profile-level-id=42e01f";
const BASELINE = "profile-level-id=42001f";
const H264 = "video/H264;level-asymmetry-allowed=1;packetization-mode=1;";

const marked = new WeakSet(); // our LiveKit connections
const relabeled = new WeakMap(); // connection -> payload types sent as Constrained Baseline

/** Whether WebRTC encodes Constrained Baseline and Baseline H.264 in hardware: true, false or null. */
export async function h264HardwareSupport() {
  const check = async (profile) => {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: "webrtc",
        video: { contentType: `${H264}profile-level-id=${profile}`, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 },
      });
      return info.supported ? info.powerEfficient : false;
    } catch {
      return null;
    }
  };
  return { constrainedBaseline: await check("42e01f"), baseline: await check("42001f") };
}

function fmtpOf(section, pt) {
  return section.match(new RegExp(`^a=fmtp:${pt} (.*)$`, "m"))?.[1] ?? "";
}

/**
 * In each video section, keeps Baseline H.264 (packetization-mode=1) as the only H.264
 * format, labeled Constrained Baseline. Returns the new SDP and the payload types changed.
 */
export function relabelOffer(sdp) {
  const pts = new Set();
  const sections = sdp.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith("m=video")) return section;
    const codecs = [...section.matchAll(/^a=rtpmap:(\d+) ([^/\s]+)\//gm)].map((m) => ({ pt: m[1], name: m[2].toLowerCase() }));
    const h264 = codecs.filter((c) => c.name === "h264");
    const baseline = h264.find((c) => {
      const fmtp = fmtpOf(section, c.pt);
      return fmtp.includes(BASELINE) && /packetization-mode=1/.test(fmtp);
    });
    if (!baseline) return section;
    const drop = new Set(h264.filter((c) => c !== baseline).map((c) => c.pt));
    for (const c of codecs) {
      const apt = fmtpOf(section, c.pt).match(/apt=(\d+)/)?.[1];
      if (c.name === "rtx" && apt && drop.has(apt)) drop.add(c.pt);
    }
    pts.add(baseline.pt);
    const lineBreak = section.includes("\r\n") ? "\r\n" : "\n";
    return section
      .split(/\r?\n/)
      .filter((line) => {
        const pt = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/)?.[1];
        return !pt || !drop.has(pt);
      })
      .map((line) => {
        if (/^m=video /.test(line)) {
          const [head, ...rest] = line.split(" ");
          const fixed = rest.slice(0, 2);
          return [head, ...fixed, ...rest.slice(2).filter((pt) => !drop.has(pt))].join(" ");
        }
        if (line.startsWith(`a=fmtp:${baseline.pt} `)) return line.replace(BASELINE, CONSTRAINED_BASELINE);
        return line;
      })
      .join(lineBreak);
  });
  return { sdp: sections.join(""), pts };
}

/** Turns the payload types we relabeled back into Baseline, for Chromium's side. */
export function relabelBack(sdp, pts) {
  let out = sdp;
  for (const pt of pts) {
    out = out.replace(new RegExp(`^(a=fmtp:${pt} .*)${CONSTRAINED_BASELINE}`, "m"), `$1${BASELINE}`);
  }
  return out;
}

let installed = false;

/** Patches offer and answer handling, for connections made inside withOurConnections() only. */
export function installHardwareH264() {
  if (installed) return;
  installed = true;
  const proto = RTCPeerConnection.prototype;
  const { createOffer, setLocalDescription, setRemoteDescription } = proto;
  proto.createOffer = async function (...args) {
    const offer = await createOffer.apply(this, args);
    if (!marked.has(this) || typeof offer?.sdp !== "string") return offer;
    const { sdp, pts } = relabelOffer(offer.sdp);
    if (!pts.size) return offer;
    relabeled.set(this, pts);
    return { type: offer.type, sdp };
  };
  proto.setLocalDescription = function (description, ...rest) {
    const pts = relabeled.get(this);
    if (pts && typeof description?.sdp === "string") description = { type: description.type, sdp: relabelBack(description.sdp, pts) };
    return setLocalDescription.call(this, description, ...rest);
  };
  proto.setRemoteDescription = function (description, ...rest) {
    const pts = relabeled.get(this);
    if (pts && description?.type === "answer" && typeof description.sdp === "string") {
      description = { type: "answer", sdp: relabelBack(description.sdp, pts) };
    }
    return setRemoteDescription.call(this, description, ...rest);
  };
}

/** Runs fn with every RTCPeerConnection created meanwhile marked as ours. */
export async function withOurConnections(fn) {
  const Native = window.RTCPeerConnection;
  const Ours = function (...args) {
    const pc = new Native(...args);
    marked.add(pc);
    return pc;
  };
  Ours.prototype = Native.prototype;
  Object.setPrototypeOf(Ours, Native);
  window.RTCPeerConnection = Ours;
  try {
    return await fn();
  } finally {
    window.RTCPeerConnection = Native;
  }
}
