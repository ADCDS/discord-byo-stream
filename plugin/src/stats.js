// Reads WebRTC stats for the on-screen diagnostics line. Test-build aid: this is
// how we learn the real encoder, frame rate and transport on each friend's PC.

const previous = new WeakMap();

function bitrateKbps(owner, bytes) {
  const now = performance.now();
  const last = previous.get(owner);
  previous.set(owner, { bytes, now });
  if (!last || now <= last.now) return 0;
  return Math.round(((bytes - last.bytes) * 8) / (now - last.now));
}

function findStat(report, predicate) {
  let found = null;
  report.forEach((stat) => {
    if (predicate(stat)) found = stat;
  });
  return found;
}

function transportOf(report) {
  const pair = findStat(report, (s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  const remote = pair && report.get(pair.remoteCandidateId);
  if (!remote) return null;
  return {
    protocol: remote.protocol,
    port: remote.port,
    rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
  };
}

export async function publisherStats(session) {
  const track = session.publishing?.videoPublication?.track;
  if (!track?.sender) return null;
  const report = await track.sender.getStats();
  const out = findStat(report, (s) => s.type === "outbound-rtp" && s.kind === "video");
  if (!out) return null;
  return {
    role: "sending",
    width: out.frameWidth,
    height: out.frameHeight,
    fps: Math.round(out.framesPerSecond ?? 0),
    kbps: bitrateKbps(track, out.bytesSent ?? 0),
    codec: report.get(out.codecId)?.mimeType?.split("/")[1],
    encoder: out.encoderImplementation,
    powerEfficient: out.powerEfficientEncoder,
    limitedBy: out.qualityLimitationReason,
    transport: transportOf(report),
  };
}

export async function viewerStats(session) {
  const watch = session.watches()[0];
  const track = watch?.video;
  if (!track?.receiver) return null;
  const report = await track.receiver.getStats();
  const inbound = findStat(report, (s) => s.type === "inbound-rtp" && s.kind === "video");
  if (!inbound) return null;
  return {
    role: "watching",
    width: inbound.frameWidth,
    height: inbound.frameHeight,
    fps: Math.round(inbound.framesPerSecond ?? 0),
    kbps: bitrateKbps(track, inbound.bytesReceived ?? 0),
    codec: report.get(inbound.codecId)?.mimeType?.split("/")[1],
    decoder: inbound.decoderImplementation,
    framesDecoded: inbound.framesDecoded,
    framesDropped: inbound.framesDropped,
    jitterMs: inbound.jitter != null ? Math.round(inbound.jitter * 1000) : null,
    transport: transportOf(report),
    audio: watch.audio ? "yes" : "no",
  };
}
