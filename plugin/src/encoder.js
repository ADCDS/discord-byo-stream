// Finds out whether a stream is encoded by the computer's video hardware. Hardware
// encoding costs almost no CPU. Software encoding at 1080p can take more CPU than a
// laptop has to spare next to a game, and then WebRTC shrinks the picture to keep up.

// The H.264 that LiveKit negotiates: constrained baseline. See h264-hardware.js for
// when Chromium encodes it as Baseline (42001f) instead.
const H264 = "video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const SOFTWARE = /OpenH264|libvpx|libaom|dav1d|SVT|FFmpeg/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the browser has a hardware H.264 encoder for this size: true, false, or null if it won't say. */
export async function hasHardwareH264({ width, height, fps, bitrate, profile = "42e01f" }) {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: { contentType: H264.replace("42e01f", profile), width, height, bitrate, framerate: fps },
    });
    return info.supported ? info.powerEfficient : false;
  } catch {
    return null;
  }
}

/** The video encoder a sender is using, once it has encoded something, or null after timeoutMs. */
export async function encoderInUse(sender, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const layers = [];
    (await sender.getStats()).forEach((stat) => {
      if (stat.type === "outbound-rtp" && stat.kind === "video" && stat.encoderImplementation) layers.push(stat);
    });
    if (layers.length) {
      const implementation = layers[0].encoderImplementation;
      return {
        implementation,
        // Chromium reports one implementation for all layers, such as
        // "SimulcastEncoderAdapter (VideoToolbox, OpenH264)", so any software name counts.
        hardware: layers.some((layer) => layer.powerEfficientEncoder === true) && !SOFTWARE.test(implementation),
        limitedBy: layers.map((layer) => layer.qualityLimitationReason).find((reason) => reason && reason !== "none") ?? "none",
      };
    }
    await sleep(250);
  }
  return null;
}

/**
 * One line on what this computer can encode, for the log: per codec, whether WebRTC
 * has it in hardware, and whether WebCodecs (the same video hardware, outside
 * WebRTC) can use the hardware encoder.
 */
export async function describeEncoders() {
  const size = { width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 };
  const parts = [];
  const h264 = (profile) => `video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`;
  const codecs = [
    ["h264", H264], ["h264-baseline", h264("42001f")], ["h264-main", h264("4d001f")], ["h264-high", h264("640c1f")],
    ["h265", "video/H265"], ["vp8", "video/VP8"], ["vp9", "video/VP9"], ["av1", "video/AV1"],
  ];
  for (const [name, contentType] of codecs) {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: { contentType, ...size } });
      parts.push(`webrtc ${name} ${info.supported ? (info.powerEfficient ? "hardware" : "software") : "none"}`);
    } catch {
      parts.push(`webrtc ${name} unknown`);
    }
  }
  for (const [name, codec] of [["h264", "avc1.42e028"], ["hevc", "hvc1.1.6.L120.B0"]]) {
    try {
      const result = await VideoEncoder.isConfigSupported({ codec, ...size, hardwareAcceleration: "prefer-hardware" });
      parts.push(`webcodecs ${name} hardware ${result.supported ? "yes" : "no"}`);
    } catch (error) {
      parts.push(`webcodecs ${name} hardware unknown (${error.name})`);
    }
  }
  return parts.join(", ");
}

/** Why the encoder is holding back ("cpu", "bandwidth", "none"), or null if unknown. */
export async function limitedBy(sender) {
  let reason = null;
  (await sender.getStats()).forEach((stat) => {
    if (stat.type === "outbound-rtp" && stat.kind === "video" && stat.qualityLimitationReason) {
      if (reason === null || reason === "none") reason = stat.qualityLimitationReason;
    }
  });
  return reason;
}

/**
 * The smaller layer of a simulcast stream: half the size (a quarter for 4K), and at
 * most 720p. The frames are a multiple of 8 in size (see keepalive.js), so this one
 * has an even size too, as hardware encoders need.
 */
export function lowLayerSize({ width, height }) {
  let scale = 2;
  while (Math.min(width, height) / scale > 720 && scale < 4) scale *= 2;
  return { width: Math.round(width / scale), height: Math.round(height / scale) };
}
