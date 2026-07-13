import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = () => readFileSync("scripts/pipecat-local-voice-bridge.py", "utf8");
const browserWebrtcBridgeSource = () => readFileSync("scripts/pipecat-browser-webrtc-bridge.py", "utf8");
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


test("Pipecat browser WebRTC bridge uses SmallWebRTCTransport with a real Pipeline", () => {
  const bridge = browserWebrtcBridgeSource();

  assert.match(bridge, /SmallWebRTCRequestHandler/);
  assert.ok(bridge.includes("SmallWebRTCRequest.from_dict"));
  assert.ok(bridge.includes("SmallWebRTCTransport"));
  assert.ok(bridge.includes("Pipeline(["));
  assert.ok(bridge.includes("transport.input()"));
  assert.ok(bridge.includes("RtcAsrTurnProcessor(session)"));
  assert.ok(bridge.includes("AccCallerTurnProcessor(session)"));
  assert.ok(bridge.includes("KokoroTtsProcessor(session)"));
  assert.ok(bridge.includes("transport.output()"));
  assert.match(bridge, /PipelineTask/);
  assert.match(bridge, /PipelineRunner/);
  assert.doesNotMatch(bridge, /RTCPeerConnection/);
  assert.doesNotMatch(bridge, /RTCSessionDescription/);
});


test("Pipecat browser WebRTC bridge keeps Chrome SDP normalization and proof metadata", () => {
  const bridge = browserWebrtcBridgeSource();

  assert.ok(bridge.includes(`def normalize_browser_answer_sdp(sdp: str) -> str:`));
  assert.ok(bridge.includes(`aiortc 1.14 can emit a=setup after ICE candidates`));
  assert.ok(bridge.includes(`if line.startswith("a=fingerprint:")`));
  assert.ok(bridge.includes(`reordered[insert_at + 1:insert_at + 1] = setup_lines`));
  assert.ok(bridge.includes(`normalize_browser_answer_sdp(str(answer.get("sdp", "")))`));
  assert.ok(bridge.includes(`"source": "pipecat_small_webrtc_pipeline"`));
  assert.ok(bridge.includes(`"runtimeMode": "pipecat_small_webrtc_pipeline"`));
  assert.ok(bridge.includes(`"transport": "SmallWebRTCTransport"`));
  assert.ok(bridge.includes(`"ffmpegRequired": False`));
});


test("Pipecat browser WebRTC bridge handles barge-in inside the Pipeline processors", () => {
  const bridge = browserWebrtcBridgeSource();

  assert.ok(bridge.includes(`class BrowserTurnSession:`));
  assert.ok(bridge.includes(`def cancel_output(self, reason: str = "barge-in") -> dict[str, Any]:`));
  assert.ok(bridge.includes(`self.output_generation += 1`));
  assert.ok(bridge.includes(`"type": "browser_webrtc_output_cancelled"`));
  assert.ok(bridge.includes(`class RtcAsrTurnProcessor(FrameProcessor):`));
  assert.ok(bridge.includes(`self.session.cancel_output("barge-in")`));
  assert.ok(bridge.includes(`turn_output_generation = self.session.output_generation`));
  assert.ok(bridge.includes(`output_cancelled = turn_output_generation != self.session.output_generation`));
  assert.ok(bridge.includes(`"cancelReason": "barge-in"`));
  assert.ok(bridge.includes(`"bargeInEvidence": turn_session.last_barge_in_evidence`));
});


test("Pipecat browser WebRTC bridge serializes finalized turns through Pipeline frame order", () => {
  const bridge = browserWebrtcBridgeSource();

  assert.ok(bridge.includes("class RtcAsrTurnProcessor(FrameProcessor):"));
  assert.ok(bridge.includes("await self.session.transcribe(InputAudioRawFrame"));
  assert.ok(bridge.includes("await self.push_frame(transcription_frame, FrameDirection.DOWNSTREAM)"));
  assert.ok(bridge.includes("class AccCallerTurnProcessor(FrameProcessor):"));
  assert.ok(bridge.includes("await self.push_frame(TextFrame(agent_text), FrameDirection.DOWNSTREAM)"));
  assert.ok(bridge.includes("class KokoroTtsProcessor(FrameProcessor):"));
  assert.ok(bridge.includes("await self.push_frame(OutputAudioRawFrame"));
  assert.equal(bridge.includes("turn_queue: asyncio.Queue"), false);
  assert.equal(bridge.includes("asyncio.create_task(pipeline.run_turn"), false);
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
  assert.match(source, /window\.__ACC_COLLECT_BROWSER_WEBRTC_LIVE_PROOF__/);
  assert.match(source, /window\.__ACC_COPY_BROWSER_WEBRTC_LIVE_PROOF__/);
  assert.match(source, /const repoHeadEvidence = /);
  assert.match(source, /gitHead: repoHeadEvidence/);
  assert.match(source, /id="voice-copy-proof"/);
  assert.match(source, /copyBrowserWebrtcLiveProof/);
  assert.match(source, /pc\.getStats\(\)/);
  assert.match(source, /browser\.microphone\.uplink/);
  assert.match(source, /pipecat\.webrtc\.offer_answer/);
  assert.match(source, /browser\.remote\.audio\.played/);
  assert.match(source, /window\.__ACC_BROWSER_WEBRTC_LIVE_PROOF__ = proof/);
  assert.match(source, /evidence: state\.voiceBridgeEvidence/);
  assert.match(source, /fetch\("\/api\/browser-webrtc\/session"/);
  assert.match(source, /typeof bridgeResponse\.payload\.sdp === "string" \? bridgeResponse\.payload\.sdp : ""/);
  assert.match(source, /!answerSdp\.trim\(\)/);
  assert.match(source, /getUserMedia/);
  assert.doesNotMatch(source, /new WebSocket/);
  assert.doesNotMatch(source, /new MediaRecorder/);
  assert.match(source, /stopVoiceStream\(\)/);
});
