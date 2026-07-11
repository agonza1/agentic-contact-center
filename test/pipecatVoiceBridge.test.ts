import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = () => readFileSync("scripts/pipecat-local-voice-bridge.py", "utf8");
const consoleSource = () => readFileSync("src/http/createServer.ts", "utf8");

test("Pipecat voice bridge uses rtc-asr and Kokoro instead of old local engines", () => {
  const bridge = source();

  assert.doesNotMatch(bridge, /import\s+mlx_whisper/);
  assert.doesNotMatch(bridge, /subprocess\.run\(\["say"/);
  assert.doesNotMatch(bridge, /synthesize_say/);
  assert.match(bridge, /InputAudioRawFrame/);
  assert.match(bridge, /STTService/);
  assert.match(bridge, /TTSService/);
  assert.match(bridge, /websockets\.connect\(self\.rtc_asr_ws_url/);
  assert.match(bridge, /"type": "start"/);
  assert.match(bridge, /"version": "local-stt\.v1"/);
  assert.match(bridge, /"type": "finalize"/);
  assert.match(bridge, /"engine": "rtc-asr"/);
  assert.match(bridge, /"engine": "kokoro"/);
  assert.match(bridge, /KOKORO_SPEECH_PATH/);
});

test("Pipecat voice bridge reports fail-closed readiness and engine evidence", () => {
  const bridge = source();

  assert.match(bridge, /"ok": readiness\.ok/);
  assert.match(bridge, /status = "ready" if ok else "degraded"/);
  assert.match(bridge, /"status": readiness\.status/);
  assert.match(bridge, /"checkedAt": checked_at/);
  assert.match(bridge, /datetime\.now\(UTC\)\.isoformat/);
  assert.match(bridge, /"error": "sidecar_unavailable"/);
  assert.match(bridge, /"blockers": readiness\.blockers/);
  assert.match(bridge, /"nextAction": .*npm run pipecat:voice:check/);
  assert.match(bridge, /"reviewGate"/);
  assert.match(bridge, /"status": review_status/);
  assert.match(bridge, /"blocked_by_local_sidecars"/);
  assert.match(bridge, /"requiredServices"/);
  assert.match(bridge, /"serviceUrls"/);
  assert.match(bridge, /"rtcAsrStream": DEFAULT_RTC_ASR_WS_URL/);
  assert.match(bridge, /"kokoroSpeech": join_url\(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_SPEECH_PATH\)/);
  assert.match(bridge, /"expectedTurnEvidence"/);
  assert.match(bridge, /"browserPlayback": "wav_base64"/);
  assert.match(bridge, /"verificationCommand": "npm run pipecat:voice:check"/);
  assert.match(bridge, /ffmpeg is not available on PATH/);
  assert.match(bridge, /"localAudio"/);
  assert.match(bridge, /legacy WebSocket\/webm proof plumbing/);
  assert.match(bridge, /normal browser WebRTC operation should not use this path/);
  assert.match(bridge, /rtc-asr health or \/v1\/models did not expose model\/backend metadata/);
  assert.match(bridge, /"mediaFlow": "pipecat_frames"/);
  assert.match(bridge, /"ready": ready/);
  assert.match(bridge, /"reviewGate": ready\["reviewGate"\]/);
  assert.match(bridge, /"stt": ready\["stt"\]/);
  assert.match(bridge, /"tts": ready\["tts"\]/);
  assert.match(bridge, /"stt": result\.stt_meta/);
  assert.match(bridge, /"tts": result\.tts_meta/);
});

test("Pipecat voice readiness scripts distinguish WebRTC from the legacy ffmpeg bridge", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const smoke = readFileSync("scripts/browser-webrtc-readiness-smoke.mjs", "utf8");

  assert.equal(pkg.scripts["browser-webrtc:check"], "node scripts/browser-webrtc-readiness-smoke.mjs");
  assert.equal(pkg.scripts["pipecat:voice:readiness"], "node scripts/browser-webrtc-readiness-smoke.mjs");
  assert.equal(pkg.scripts["pipecat:voice:check"], "python3 scripts/pipecat-local-voice-bridge.py --check-sidecars");
  assert.match(smoke, /browserWebRtc\.normalOperation\?\.transport !== "webrtc"/);
  assert.match(smoke, /mediaRecorderRequired !== false/);
  assert.match(smoke, /ffmpegRequired !== false/);
  assert.match(smoke, /pipecatWebrtcBridge\?\.status !== "signaling_ready"/);
  assert.match(smoke, /Browser WebRTC readiness OK/);
});


test("operator console surfaces fail-closed voice bridge readiness", () => {
  const source = consoleSource();

  assert.match(source, /state\.voiceBridge\.status === "degraded"/);
  assert.match(source, /return "WebRTC blocked"/);
  assert.match(source, /function browserWebrtcReadinessUrl\(\)/);
  assert.match(source, /return "\/api\/browser-webrtc\/readiness"/);
  assert.match(source, /function formatVoiceBridgeReadyDetail\(payload\)/);
  assert.match(source, /payload\.nextActions/);
  assert.match(source, /blockers\.slice\(0, 3\)/);
  assert.match(source, /function formatVoiceBridgeEngineEvidence\(payload\)/);
  assert.match(source, /formatVoiceBridgeEngineEvidence\(payload\)/);
  assert.match(source, /fetch\(browserWebrtcReadinessUrl\(\)\)/);
  assert.match(source, /payload\.ok/);
  assert.match(source, /new RTCPeerConnection/);
  assert.match(source, /fetch\("\/api\/browser-webrtc\/session"/);
  assert.match(source, /getUserMedia/);
  assert.doesNotMatch(source, /new WebSocket/);
  assert.doesNotMatch(source, /new MediaRecorder/);
  assert.match(source, /stopVoiceStream\(\)/);
});
