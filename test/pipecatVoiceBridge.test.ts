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
  assert.match(bridge, /"error": "sidecar_unavailable"/);
  assert.match(bridge, /"blockers": readiness\.blockers/);
  assert.match(bridge, /"nextAction": .*npm run pipecat:voice:check/);
  assert.match(bridge, /"reviewGate"/);
  assert.match(bridge, /"status": review_status/);
  assert.match(bridge, /"blocked_by_local_sidecars"/);
  assert.match(bridge, /"requiredServices"/);
  assert.match(bridge, /"verificationCommand": "npm run pipecat:voice:check"/);
  assert.match(bridge, /ffmpeg is not available on PATH/);
  assert.match(bridge, /"localAudio"/);
  assert.match(bridge, /rtc-asr health or \/v1\/models did not expose model\/backend metadata/);
  assert.match(bridge, /"mediaFlow": "pipecat_frames"/);
  assert.match(bridge, /"stt": result\.stt_meta/);
  assert.match(bridge, /"tts": result\.tts_meta/);
});

test("Pipecat voice check script is exposed", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["pipecat:voice:check"], "python3 scripts/pipecat-local-voice-bridge.py --check-sidecars");
});


test("operator console surfaces fail-closed voice bridge readiness", () => {
  const source = consoleSource();

  assert.match(source, /state\.voiceBridge\.status === "degraded"/);
  assert.match(source, /return "Bridge blocked"/);
  assert.match(source, /payload\.type === "ready" && payload\.ok === false/);
  assert.match(source, /finish\("degraded", payload\.detail/);
  assert.match(source, /Waiting for ready message from/);
  assert.match(source, /function startVoiceCall\(\)/);
  assert.match(source, /function blockVoiceStart\(detail\)/);
  assert.match(source, /payload\.type === "ready"/);
  assert.match(source, /startVoiceCall\(\)/);
  assert.match(source, /payload\.type === "started"/);
  assert.match(source, /payload\.ok === false/);
  assert.match(source, /updateVoiceBridgeStatus\("degraded", ready\.detail \|\| state\.voiceStatus\)/);
  assert.match(source, /stopVoiceStream\(\)/);
});
