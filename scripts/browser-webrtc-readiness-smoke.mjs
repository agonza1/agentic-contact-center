#!/usr/bin/env node

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const url = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8026/health";

if (!url) {
  console.error("Missing --url value");
  process.exit(2);
}

const response = await fetch(url);
if (!response.ok) {
  console.error(`Readiness probe failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const payload = await response.json();
const browserWebRtc = payload.browserWebRtc ?? payload;
const failures = [];

if (browserWebRtc.ok !== true) failures.push("browserWebRtc.ok must be true");
if (browserWebRtc.status !== "contract_ready_pending_live_media_evidence") failures.push("browserWebRtc.status must be contract_ready_pending_live_media_evidence");
if (browserWebRtc.normalOperation?.transport !== "webrtc") failures.push("normalOperation.transport must be webrtc");
if (browserWebRtc.normalOperation?.mediaRecorderRequired !== false) failures.push("normalOperation.mediaRecorderRequired must be false");
if (browserWebRtc.normalOperation?.ffmpegRequired !== false) failures.push("normalOperation.ffmpegRequired must be false");
if (browserWebRtc.readiness?.acc?.status !== "ready") failures.push("ACC readiness must be ready");
if (browserWebRtc.readiness?.pipecatWebrtcBridge?.status !== "signaling_ready") failures.push("Pipecat WebRTC bridge readiness must be signaling_ready");
if (browserWebRtc.readiness?.rtcAsr?.engine !== "rtc-asr") failures.push("rtc-asr readiness must be present");
if (browserWebRtc.readiness?.kokoro?.engine !== "kokoro") failures.push("Kokoro readiness must be present");
if (browserWebRtc.contract?.signalingRoute !== "POST /api/browser-webrtc/session") failures.push("contract.signalingRoute must be POST /api/browser-webrtc/session");
if (!browserWebRtc.contract?.bridgeOfferRoute?.endsWith("/api/webrtc/offer")) failures.push("contract.bridgeOfferRoute must target the Pipecat WebRTC offer route");
if (browserWebRtc.contract?.media?.input !== "opus over WebRTC from browser microphone") failures.push("contract.media.input must describe browser WebRTC audio");
if (browserWebRtc.liveMedia?.verified !== false) failures.push("liveMedia.verified must remain false until local browser media proof is attached");
if (!browserWebRtc.blockers?.includes("live_webrtc_media_turn_evidence_missing")) failures.push("live media evidence blocker must be reported");

if (failures.length) {
  console.error("Browser WebRTC readiness check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Browser WebRTC readiness OK: ${browserWebRtc.route ?? url}`);
