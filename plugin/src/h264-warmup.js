// Discord's Chromium decodes H.264 through FFmpeg, with the OpenH264 library Discord
// downloads (Linux), and tells FFmpeg where that library is only when its media code
// first runs. WebRTC's H.264 decoder skips that step, so until something else in the
// page has decoded video, every stream fails with "avcodec_open2 error" in Discord's log
// and viewers see nothing but hear the sound. Configuring a WebCodecs decoder once runs
// that setup; WebRTC decodes from then on.
export async function warmUpH264Decoding(log) {
  if (typeof VideoDecoder !== "function") return;
  let decoder;
  try {
    decoder = new VideoDecoder({ output: (frame) => frame.close(), error: () => {} });
    decoder.configure({ codec: "avc1.42e01f" });
    // flush() resolves once the configure has run, so the setup is done.
    await Promise.race([decoder.flush(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  } catch (error) {
    log(`H.264 decoder warm-up failed: ${error.message}`);
  } finally {
    try {
      decoder?.close();
    } catch {
      // Already closed.
    }
  }
}
