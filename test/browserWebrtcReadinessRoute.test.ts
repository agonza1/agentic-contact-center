import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("browser WebRTC bridge uses SmallWebRTCTransport with a real Pipecat Pipeline", () => {
  const bridge = readFileSync("scripts/pipecat-browser-webrtc-bridge.py", "utf8");
  const sharedPipeline = readFileSync("scripts/acc_pipecat_voice_pipeline.py", "utf8");

  assert.match(bridge, /SmallWebRTCRequestHandler/);
  assert.match(bridge, /SmallWebRTCTransport/);
  assert.match(bridge, /build_acc_voice_pipeline/);
  assert.match(bridge, /transport_input=transport\.input\(\)/);
  assert.match(bridge, /transport_output=transport\.output\(\)/);
  assert.match(bridge, /ACC_VOICE_PIPELINE_CONTRACT/);
  assert.match(sharedPipeline, /Pipeline\(\[/);
  assert.match(sharedPipeline, /RtcAsrTurnProcessor\(session\)/);
  assert.match(sharedPipeline, /AccCallerTurnProcessor\(session\)/);
  assert.match(sharedPipeline, /KokoroTtsProcessor\(session\)/);
  assert.match(sharedPipeline, /record_stage/);
  assert.match(sharedPipeline, /stt\.empty_transcript/);
  assert.match(sharedPipeline, /ensure_rtc_asr_stream/);
  assert.match(sharedPipeline, /stream_rtc_asr_audio/);
  assert.match(sharedPipeline, /stt\.session_started/);
  assert.match(sharedPipeline, /stt\.transcript_interim/);
  assert.match(sharedPipeline, /persistentSession/);
  assert.match(sharedPipeline, /connectionId/);
  assert.match(sharedPipeline, /close_rtc_asr_stream/);
  assert.match(sharedPipeline, /self\.session\.stream_rtc_asr_audio\(pcm\)/);
  assert.match(sharedPipeline, /self\.rtc_asr_current_audio_bytes == 0/);
  assert.match(sharedPipeline, /self\.rtc_asr_ws is not None and self\.rtc_asr_started/);
  assert.match(sharedPipeline, /begin_output_stream/);
  assert.match(sharedPipeline, /extend_output_window/);
  assert.match(sharedPipeline, /no_active_output_audio/);
  assert.match(sharedPipeline, /InterruptionFrame/);
  assert.match(sharedPipeline, /broadcast_frame\(InterruptionFrame\)/);
  assert.match(sharedPipeline, /MinWordsUserTurnStartStrategy\(min_words=self\.min_words/);
  assert.match(sharedPipeline, /ACC_WEBRTC_BARGE_IN_MIN_WORDS", "2"/);
  assert.match(sharedPipeline, /LocalSmartTurnAnalyzerV3/);
  assert.match(sharedPipeline, /turn\.smart_turn_decision/);
  assert.match(sharedPipeline, /min_words_barge_in/);
  assert.doesNotMatch(sharedPipeline, /finalize_turn\("audio_frame"\)/);
  assert.match(sharedPipeline, /pipecatInterruptionFrame/);
  assert.match(sharedPipeline, /outputWindow/);
  assert.match(sharedPipeline, /TTSStartedFrame/);
  assert.match(sharedPipeline, /TTSAudioRawFrame\(audio=audio_chunk/);
  assert.match(sharedPipeline, /TTSStoppedFrame/);
  assert.match(sharedPipeline, /ACC_TTS_OUTPUT_CHUNK_MS/);
  assert.match(sharedPipeline, /ACC_TTS_OUTPUT_CHUNK_YIELD_MS/);
  assert.match(sharedPipeline, /speech_started_barge_in/);
  assert.match(sharedPipeline, /output\.transport_flushed/);
  assert.match(sharedPipeline, /transportFlushLatencyMs/);
  assert.match(sharedPipeline, /active_agent_task/);
  assert.match(sharedPipeline, /active_tts_task/);
  assert.match(sharedPipeline, /stage_events/);
  assert.match(bridge, /skipAcc/);
  assert.match(bridge, /event_handler\("closed"\)/);
  assert.match(bridge, /session_record=session_record/);
  assert.match(bridge, /reason="small_webrtc_peer_closed"/);
  assert.match(bridge, /forget_session_record/);
  assert.match(sharedPipeline, /silence_finalize_task/);
  assert.match(sharedPipeline, /finalize_after_silence/);
  assert.match(sharedPipeline, /finalize_turn\("silence_timer"\)/);
  assert.doesNotMatch(bridge, /RTCPeerConnection/);
  assert.doesNotMatch(bridge, /RTCSessionDescription/);
});

test("browser WebRTC close interrupts rtc-asr before awaiting runner shutdown", () => {
  const bridge = readFileSync("scripts/pipecat-browser-webrtc-bridge.py", "utf8");
  const closeIndex = bridge.indexOf("await turn_session.close_rtc_asr_stream(reason)");
  const cancelIndex = bridge.indexOf("await runner.cancel(reason)");
  const taskCancelIndex = bridge.indexOf("task.cancel()");

  assert.ok(closeIndex > 0, "expected close_session to close rtc-asr");
  assert.ok(cancelIndex > 0, "expected close_session to cancel the runner");
  assert.ok(taskCancelIndex > 0, "expected close_session to cancel the runner task");
  assert.ok(closeIndex < cancelIndex, "rtc-asr should close before runner cancellation is awaited");
  assert.ok(closeIndex < taskCancelIndex, "rtc-asr should close before runner task shutdown is awaited");
});

const hasOptionalPipecatRuntime = existsSync(".pipecat-runtime");

test("persistent rtc-asr session repeats utterance lifecycle and closes promptly", { skip: !hasOptionalPipecatRuntime }, () => {
  const payload = JSON.parse(execFileSync("python3", [
    "test/fixtures/rtc_asr_persistent_session_regression.py",
  ], { encoding: "utf8" }).trim().split("\n").at(-1) ?? "{}");

  assert.equal(payload.ok, true);
  assert.equal(payload.twoTurnLifecycle, "one_connection_two_starts_two_finalizes_two_transcripts");
  assert.equal(payload.promptClose, true);
});

test("Pipecat transport output streams chunks and flushes on barge-in", { skip: !hasOptionalPipecatRuntime }, () => {
  const payload = JSON.parse(execFileSync("python3", [
    "test/fixtures/pipecat_output_barge_in_regression.py",
  ], { encoding: "utf8" }).trim().split("\n").at(-1) ?? "{}");

  assert.equal(payload.ok, true);
  assert.equal(payload.normal.chunks, 6);
  assert.equal(payload.normal.flowManager.commitPolicy, "delivery_ack_committed");
  assert.equal(payload.normal.flowManager.currentNode, "diagnose");
  assert.equal(payload.normal.flowManager.pendingTransition, null);
  assert.equal(payload.interrupted.chunksBeforeStop, 1);
  assert.equal(payload.interrupted.transportOutputFlushed, true);
  assert.equal(payload.resumed.chunks, 3);
  assert.equal(payload.checks.noStalePlaybackAfterInterruption, true);
  assert.deepEqual(payload.flowManagerActivationFailure.requests, ["fallback"]);
  assert.equal(payload.flowManagerActivationFailure.audioChunks, 0);
  assert.equal(payload.flowManagerActivationFailure.ttsStarted, 1);
  assert.equal(payload.flowManagerActivationFailure.ttsStopped, 1);
  assert.deepEqual(payload.flowManagerActivationFailure.turnControls, {
    started: 1,
    stopped: 1,
    botSpeaking: false,
  });
  assert.deepEqual(payload.slowCommitBargeIn, {
    audioChunksBeforeCancel: 1,
    commitCalls: 1,
    cancelled: true,
    outputChunksAtCancel: 1,
  });
  assert.deepEqual(payload.failedCommitAfterCancellation, {
    commitCalls: 1,
    cancelled: true,
    pendingCommit: false,
    pendingTransition: false,
    outputChunksAtCancel: 1,
  });
  assert.deepEqual(payload.stalePriorAudioPreAudioCancel, {
    cancelled: true,
    outputChunksAtCancel: 0,
    pendingCommit: false,
  });
  assert.deepEqual(payload.flowManagerFallbackFailure.requests, ["fallback"]);
  assert.equal(payload.flowManagerFallbackFailure.audioChunks, 0);
  assert.equal(payload.flowManagerFallbackFailure.ttsStarted, 1);
  assert.equal(payload.flowManagerFallbackFailure.ttsStopped, 1);
  assert.deepEqual(payload.flowManagerFallbackFailure.turnControls, {
    started: 1,
    stopped: 1,
    botSpeaking: false,
  });
  assert.equal(payload.flowManagerFallbackFailure.pendingCommit, false);
  assert.equal(payload.flowManagerFallbackFailure.pendingTransition, false);
  assert.equal(payload.slowFlowManagerActivationBargeIn.audioChunks, 0);
  assert.equal(payload.slowFlowManagerActivationBargeIn.cancelled, true);
  assert.equal(payload.slowFlowManagerActivationBargeIn.currentNode, "call_started");
  assert.equal(payload.slowFlowManagerActivationBargeIn.pendingTransition, null);
  assert.equal(payload.checks.slowFlowManagerActivationBargeInRollsBack, true);
  assert.equal(payload.checks.slowFlowManagerActivationCancellationIsPrompt, true);
  assert.equal(payload.checks.slowFlowManagerActivationCommitsNoAudioOrAccTurn, true);
  assert.equal(payload.checks.slowCommitStartsOnlyAfterFirstAudio, true);
  assert.equal(payload.checks.slowCommitBargeInPreservesDeliveredCommit, true);
  assert.equal(payload.checks.successfulTurnPublishesFinalizedFlowManagerEvidence, true);
  assert.equal(payload.checks.failedCommitAfterCancellationCleansPendingDelivery, true);
  assert.equal(payload.checks.stalePriorAudioCounterDoesNotPreservePreAudioCommit, true);
  assert.equal(payload.checks.flowManagerActivationFailureClosesTtsLifecycle, true);
  assert.equal(payload.checks.flowManagerActivationFailureRecordsNoCommittedDelivery, true);
  assert.equal(payload.checks.flowManagerActivationFailureRetainsTerminalEvidence, true);
  assert.equal(payload.checks.flowManagerFallbackFailureClosesZeroAudioLifecycle, true);
  assert.equal(payload.checks.flowManagerFallbackFailureClearsPendingDelivery, true);
  assert.deepEqual(payload.activeTasks.cancelled.sort(), ["agent", "tts"]);
});

test("fixture adapter smoke check is wired to the shared Pipeline contract", () => {
  const adapter = readFileSync("scripts/pipecat-fixture-pipeline-smoke.py", "utf8");
  assert.match(adapter, /fixture_audio_injection/);
  assert.match(adapter, /build_acc_voice_pipeline/);
  assert.match(adapter, /InputAudioRawFrame/);
  assert.match(adapter, /OutputAudioRawFrame\|TTSAudioRawFrame/);
  assert.match(adapter, /api\/demo\/start/);
  assert.match(adapter, /pipeline\.queue_frame\(input_frame/);
  assert.match(adapter, /contextlib\.redirect_stdout\(sys\.stderr\)/);

  const payload = JSON.parse(execFileSync("python3", [
    "scripts/pipecat-fixture-pipeline-smoke.py",
    "--contract-only",
  ], { encoding: "utf8" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.adapter, "fixture_audio_injection");
  assert.equal(payload.mode, "contract_only");
  assert.equal(payload.sidecarsRequired, false);
  assert.equal(payload.targetPipelineBuilder, "scripts/acc_pipecat_voice_pipeline.py:build_acc_voice_pipeline");
  assert.match(payload.repoHead, /^[0-9a-f]{12}$/);
  assert.match(payload.targetPipelineSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(payload.missingContractTokens, []);
  assert.equal(payload.contractChecks.contract_constant.present, true);
  assert.equal(payload.contractChecks.pipeline_builder.token, "def build_acc_voice_pipeline");
  assert.equal(payload.contractChecks.rtc_asr_persistent_start.present, true);
  assert.equal(payload.contractChecks.rtc_asr_streaming_audio.present, true);
  assert.equal(payload.contractChecks.rtc_asr_interim_events.present, true);
  assert.equal(payload.contractChecks.rtc_asr_connection_reuse.present, true);
  assert.equal(payload.contractChecks.transport_input_boundary.present, true);
  assert.equal(payload.contractChecks.transport_output_boundary.present, true);
  assert.deepEqual(payload.pipelineStages, [
    "transport.input",
    "RtcAsrTurnProcessor",
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "transport.output",
  ]);
});

test("operator console polls browser WebRTC session proof for turn diagnostics", () => {
  const serverSource = readFileSync("src/http/createServer.ts", "utf8");

  assert.match(serverSource, /pollVoiceSessionProof/);
  assert.match(serverSource, /armVoiceSessionProofPolling/);
  assert.match(serverSource, /Audio reached the Pipecat bridge, but rtc-asr returned an empty transcript/);
  assert.match(serverSource, /rtc-asr transcript arrived/);
  assert.match(serverSource, /voiceLiveAudioVerified/);
  assert.match(serverSource, /voiceLiveTurnVerified/);
  assert.match(serverSource, /hasVerifiedLiveVoiceSession/);
  assert.match(serverSource, /proofBlocked/);
  assert.match(serverSource, /Live browser WebRTC audio remains verified; latest incomplete rtc-asr proof is available from Copy Proof/);
  assert.match(serverSource, /if \(!state\.voiceMuted\) setStatus\("Live browser WebRTC audio remains verified"\)/);
  assert.match(serverSource, /voiceLastProofTurnCount/);
  assert.match(serverSource, /await refresh\(\);/);
  assert.match(serverSource, /armVoiceSessionProofPolling\(\);/);
  assert.doesNotMatch(serverSource, /voiceOpenConversation/);
  assert.doesNotMatch(serverSource, /voice-open-conversation/);
  assert.doesNotMatch(serverSource, /Open voice AI/);
  assert.match(serverSource, /track\.enabled = true; pc\.addTrack/);
  assert.match(serverSource, /connectLabel = voiceConnected \? "Voice Connected" : "Connect Voice"/);
  assert.match(serverSource, /muteDisabled = voiceConnected \? "" : " disabled"/);
  assert.match(serverSource, /muteTitle = voiceConnected \? muteLabel : "Connect Voice first"/);
  assert.match(serverSource, /togglePipecatMute/);
  assert.match(serverSource, /muteIcon/);
  assert.match(serverSource, /aria-label="' \+ muteTitle/);
  assert.match(serverSource, /const advancedActions = \["escalate_to_human", "arm_fallback", "disarm_fallback"\]/);
  assert.match(serverSource, /approvalPending \? \["approve_offer", "deny_offer"\]/);
  assert.match(serverSource, /callOnHold \? "resume" : "pause"/);
  assert.match(serverSource, /primaryActions\.push\("takeover", "transfer", "end_call"\)/);
  assert.doesNotMatch(serverSource, /const actions = \[[^\]]*"ask_operator"/);
});

test("GET /api/browser-webrtc/readiness exposes issue 213 WebRTC route contract", async () => {
  const bridge = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true, status: "ready", detail: "test bridge ready" }));
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/browser-webrtc/readiness",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      issue: string;
      status: string;
      intendedPath: string;
      normalOperation: {
        transport: string;
        mediaRecorderRequired: boolean;
        ffmpegRequired: boolean;
      };
      readiness: {
        acc: { status: string };
        pipecatWebrtcBridge: { status: string; bridgeUrl: string; healthUrl: string; timeoutMs: number; failClosedWhenUnavailable: boolean };
        rtcAsr: { status: string; engine: string; contract: string };
        kokoro: { status: string; engine: string };
      };
      contract: {
        signalingRoute: string;
        readinessRoute: string;
        bridgeTimeoutMs: number;
        sidecars: { stt: string; tts: string };
      };
      preservation: Record<string, boolean | string>;
      acceptanceProgress: Array<{ criterion: string; passed: boolean; evidence: string }>;
      liveMedia: {
        verified: boolean;
        status: string;
        requiredProof: string[];
        setupCommands: string[];
      };
      blockers: string[];
      nextActions: string[];
      validationCommands: string[];
      contractReady: boolean;
      liveMediaVerified: boolean;
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/browser-webrtc/readiness");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#213");
    assert.equal(payload.status, "contract_ready_pending_live_media_evidence");
    assert.match(payload.intendedPath, /browser microphone -> WebRTC -> Pipecat bridge/);
    assert.deepEqual(payload.normalOperation, {
      transport: "webrtc",
      browserCapture: "getUserMedia MediaStreamTrack",
      browserPlayback: "WebRTC remote audio track",
      mediaRecorderRequired: false,
      ffmpegRequired: false,
    });
    assert.equal(payload.readiness.acc.status, "ready");
    assert.equal(payload.readiness.pipecatWebrtcBridge.status, "signaling_ready");
    assert.equal(payload.readiness.pipecatWebrtcBridge.failClosedWhenUnavailable, true);
    assert.equal(payload.readiness.pipecatWebrtcBridge.timeoutMs, 5000);
    assert.match(payload.readiness.pipecatWebrtcBridge.bridgeUrl, /127\.0\.0\.1/);
    assert.match(payload.readiness.pipecatWebrtcBridge.healthUrl, /\/health\?skipAcc=1$/);
    assert.deepEqual(payload.readiness.rtcAsr, {
      status: "contract_ready",
      engine: "rtc-asr",
      contract: "local-stt.v1",
    });
    assert.deepEqual(payload.readiness.kokoro, {
      status: "contract_ready",
      engine: "kokoro",
    });
    assert.equal(payload.contract.signalingRoute, "POST /api/browser-webrtc/session");
    assert.equal(payload.contract.readinessRoute, "/api/browser-webrtc/readiness");
    assert.equal(payload.contract.bridgeTimeoutMs, 5000);
    assert.deepEqual(payload.contract.sidecars, {
      stt: "rtc-asr Local STT v1",
      tts: "Kokoro",
    });
    assert.equal(payload.preservation.callState, true);
    assert.equal(payload.preservation.transcript, true);
    assert.equal(payload.preservation.eventTrail, true);
    assert.equal(payload.preservation.latencyEvidence, true);
    assert.equal(payload.preservation.proofRoutes, true);
    assert.equal(payload.preservation.operatorConsole, true);
    assert.deepEqual(
      Object.fromEntries(payload.acceptanceProgress.map((criterion) => [criterion.criterion, criterion.passed])),
      {
        readiness_distinguishes_acc_pipecat_webrtc_rtc_asr_kokoro: true,
        normal_browser_voice_does_not_require_mediarecorder_or_ffmpeg: true,
        browser_offer_answer_signaling: true,
        live_webrtc_media_turn: false,
      },
    );
    assert.equal(payload.liveMedia.verified, false);
    assert.equal(payload.liveMedia.status, "pending_local_bridge_proof");
    assert.deepEqual(payload.liveMedia.requiredProof, [
      "Pipecat WebRTC bridge started at BROWSER_WEBRTC_BRIDGE_URL",
      "rtc-asr Local STT v1 sidecar captured a final browser transcript",
      "Kokoro produced agent TTS audio",
      "browser received and played a remote WebRTC audio track",
    ]);
    assert.ok(payload.liveMedia.setupCommands.some((command) => command.includes("BROWSER_WEBRTC_BRIDGE_URL")));
    assert.deepEqual(payload.blockers, ["live_webrtc_media_turn_evidence_missing"]);
    assert.match(payload.nextActions[0] ?? "", /Capture one browser voice turn/);
    assert.match(payload.nextActions[2] ?? "", /issue #222/);
    assert.deepEqual(payload.validationCommands, ["npm test", "npm run browser-webrtc:check -- --url http://127.0.0.1:8026/health"]);
    assert.equal(payload.contractReady, true);
    assert.equal(payload.liveMediaVerified, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
  }
});


test("GET /api/browser-webrtc/readiness reports bridge offline before live media proof", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  const unavailableBridge = createServer();
  await new Promise<void>((resolve) => unavailableBridge.listen(0, "127.0.0.1", resolve));
  const unavailableAddress = unavailableBridge.address();
  if (!unavailableAddress || typeof unavailableAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  await new Promise<void>((resolve, reject) => unavailableBridge.close((error) => error ? reject(error) : resolve()));
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  const previousTimeout = process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${unavailableAddress.port}`;
  process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS = "50";

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: address.port, path: "/api/browser-webrtc/readiness", method: "GET" },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const payload = JSON.parse(responseBody) as { ok: boolean; status: string; readiness: { pipecatWebrtcBridge: { status: string; blockers: string[]; healthUrl: string } }; blockers: string[]; nextActions: string[]; architectureIssue: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "realtime_contract_blocked_bridge_offline");
    assert.equal(payload.architectureIssue, "agonza1/agentic-contact-center#222");
    assert.equal(payload.readiness.pipecatWebrtcBridge.status, "offline");
    assert.deepEqual(payload.readiness.pipecatWebrtcBridge.blockers, ["pipecat_webrtc_bridge_unavailable"]);
    assert.ok(payload.blockers.includes("pipecat_webrtc_bridge_unavailable"));
    assert.ok(payload.blockers.includes("live_webrtc_media_turn_evidence_missing"));
    assert.match(payload.nextActions[0] ?? "", /confirm .*\/health\?skipAcc=1 returns ok=true/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    if (previousTimeout === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS = previousTimeout;
    }
  }
});


test("POST /api/browser-webrtc/session proxies browser SDP offers to Pipecat bridge", async () => {
  const bridgeRequests: Array<{ callId?: string; sdp?: string; type?: string; accUrl?: string; sessionId?: string }> = [];
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/webrtc/offer") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    bridgeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      ok: true,
      type: "answer",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=ACC Pipecat WebRTC\r\nt=0 0\r\n",
      sessionId: "smallwebrtc-generated-pc-id",
      pcId: "smallwebrtc-generated-pc-id",
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      evidence: { pipecatTransport: "webrtc", stt: { engine: "rtc-asr" }, tts: { engine: "kokoro" } },
    }));
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/browser-webrtc/session",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=browser\r\nt=0 0\r\n" }));
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      sessionId: string;
      requestedSessionId: string;
      callId: string;
      type: string;
      sdp: string;
      iceServers: Array<{ urls: string }>;
      evidence: { mediaRecorderRequired: boolean; ffmpegRequired: boolean; stt: { engine: string }; tts: { engine: string } };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/browser-webrtc/session");
    assert.equal(payload.sessionId, "smallwebrtc-generated-pc-id");
    assert.equal(payload.requestedSessionId, bridgeRequests[0]?.sessionId);
    assert.equal(payload.type, "answer");
    assert.equal(payload.sdp, "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=ACC Pipecat WebRTC\r\nt=0 0\r\n");
    assert.equal(payload.iceServers[0].urls, "stun:stun.l.google.com:19302");
    assert.equal(payload.evidence.mediaRecorderRequired, false);
    assert.equal(payload.evidence.ffmpegRequired, false);
    assert.equal(payload.evidence.stt.engine, "rtc-asr");
    assert.equal(payload.evidence.tts.engine, "kokoro");
    const bridgeRequest = bridgeRequests[0];
    assert.equal(bridgeRequest?.type, "offer");
    assert.equal(bridgeRequest?.callId, payload.callId);
    assert.match(bridgeRequest?.accUrl ?? "", new RegExp(String(address.port)));
  } finally {
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});
test("GET /api/browser-webrtc/session/:sessionId/proof follows generated SmallWebRTC pc_id", async () => {
  const bridgeRequests: string[] = [];
  const bridge = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/webrtc/offer") {
      bridgeRequests.push("offer");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        type: "answer",
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=ACC Pipecat WebRTC\r\nt=0 0\r\n",
        sessionId: "smallwebrtc-generated-pc-id",
        pcId: "smallwebrtc-generated-pc-id",
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        evidence: { pipecatTransport: "webrtc", stt: { engine: "rtc-asr" }, tts: { engine: "kokoro" } },
      }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/webrtc/sessions/smallwebrtc-generated-pc-id/proof") {
      bridgeRequests.push(request.url ?? "");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: true,
        sessionId: "smallwebrtc-generated-pc-id",
        callId: "call-123",
        turnEvidence: {
          callerTranscript: "I need help with billing.",
          stt: { engine: "rtc-asr", audioBytes: 32000 },
          tts: { engine: "kokoro", audioBytes: 64000 },
        },
        lastAudio: { stage: "audio.frame", rms: 612, frameBytes: 640 },
        lastStt: { stage: "stt.transcript_final", transcript: "I need help with billing." },
        lastAcc: { stage: "acc.caller_turn_completed", flowState: "diagnose" },
        lastTts: { stage: "tts.audio_ready", tts: { audioBytes: 64000 } },
        lastError: {},
        stageEvents: [
          { stage: "audio.speech_started", ok: true },
          { stage: "stt.transcript_final", ok: true },
          { stage: "tts.audio_ready", ok: true },
        ],
        reviewReady: true,
      }));
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const sessionResponse = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/browser-webrtc/session",
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=browser\r\nt=0 0\r\n" }));
    });
    const sessionPayload = JSON.parse(sessionResponse) as { sessionId: string };

    const proofResponse = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: address.port,
        path: `/api/browser-webrtc/session/${sessionPayload.sessionId}/proof`,
        method: "GET",
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
    const proofPayload = JSON.parse(proofResponse) as { ok: boolean; sessionId: string; bridge: { reviewReady: boolean } };

    assert.equal(sessionPayload.sessionId, "smallwebrtc-generated-pc-id");
    assert.equal(proofPayload.ok, true);
    assert.equal(proofPayload.sessionId, "smallwebrtc-generated-pc-id");
    assert.equal(proofPayload.bridge.reviewReady, true);
    assert.deepEqual(bridgeRequests, ["offer", "/api/webrtc/sessions/smallwebrtc-generated-pc-id/proof"]);
  } finally {
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});

test("GET /api/browser-webrtc/session/:sessionId/proof proxies Pipecat bridge turn evidence", async () => {
  const bridgeRequests: string[] = [];
  const bridge = createServer((_request, response) => {
    bridgeRequests.push(_request.url ?? "");
    if (_request.method !== "GET" || _request.url !== "/api/webrtc/sessions/browser-webrtc-session-123/proof") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      ok: true,
      sessionId: "browser-webrtc-session-123",
      callId: "call-123",
      turnEvidence: {
        callerTranscript: "I need help with billing.",
        stt: { engine: "rtc-asr", audioBytes: 32000 },
        tts: { engine: "kokoro", audioBytes: 64000 },
      },
      lastAudio: { stage: "audio.frame", rms: 612, frameBytes: 640 },
      lastStt: { stage: "stt.transcript_final", transcript: "I need help with billing." },
      lastAcc: { stage: "acc.caller_turn_completed", flowState: "diagnose" },
      lastTts: { stage: "tts.audio_ready", tts: { audioBytes: 64000 } },
      lastError: {},
      stageEvents: [
        { stage: "audio.speech_started", ok: true },
        { stage: "stt.transcript_final", ok: true },
        { stage: "tts.audio_ready", ok: true },
      ],
      reviewReady: true,
    }));
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/browser-webrtc/session/browser-webrtc-session-123/proof",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      sessionId: string;
      bridge: {
        turnEvidence: { callerTranscript: string; tts: { audioBytes: number } };
        lastAudio: { rms: number };
        lastStt: { stage: string };
        stageEvents: Array<{ stage: string }>;
        reviewReady: boolean;
      };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/browser-webrtc/session/:sessionId/proof");
    assert.equal(payload.sessionId, "browser-webrtc-session-123");
    assert.equal(payload.bridge.turnEvidence.callerTranscript, "I need help with billing.");
    assert.equal(payload.bridge.turnEvidence.tts.audioBytes, 64000);
    assert.equal(payload.bridge.lastAudio.rms, 612);
    assert.equal(payload.bridge.lastStt.stage, "stt.transcript_final");
    assert.equal(payload.bridge.stageEvents.some((event) => event.stage === "tts.audio_ready"), true);
    assert.equal(payload.bridge.reviewReady, true);
    assert.deepEqual(bridgeRequests, ["/api/webrtc/sessions/browser-webrtc-session-123/proof"]);
  } finally {
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});

test("POST /api/browser-webrtc/session fails closed when Pipecat bridge is unavailable", async () => {
  const bridge = createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: false, error: "bridge_booting" }));
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const { statusCode, responseBody } = await new Promise<{ statusCode: number; responseBody: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/browser-webrtc/session",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, responseBody: body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=browser\r\nt=0 0\r\n" }));
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      error: string;
      bridgeStatus: number;
      bridge: { error?: string };
    };

    assert.equal(statusCode, 502);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "pipecat_webrtc_bridge_offer_failed");
    assert.equal(payload.bridgeStatus, 503);
    assert.equal(payload.bridge.error, "bridge_booting");
  } finally {
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});

test("POST /api/browser-webrtc/session times out stalled Pipecat bridge offers", async () => {
  const bridge = createServer((_request, response) => {
    response.on("close", () => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeAddress = bridge.address();
  if (!bridgeAddress || typeof bridgeAddress === "string") {
    throw new Error("Expected an ephemeral bridge TCP port");
  }
  const previousBridgeUrl = process.env.BROWSER_WEBRTC_BRIDGE_URL;
  const previousBridgeTimeout = process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS;
  process.env.BROWSER_WEBRTC_BRIDGE_URL = `http://127.0.0.1:${bridgeAddress.port}`;
  process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS = "50";

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const { statusCode, responseBody } = await new Promise<{ statusCode: number; responseBody: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/browser-webrtc/session",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, responseBody: body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=browser\r\nt=0 0\r\n" }));
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      error: string;
      detail: string;
      readiness: { readiness: { pipecatWebrtcBridge: { timeoutMs: number } }; contract: { bridgeTimeoutMs: number } };
    };

    assert.equal(statusCode, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "pipecat_webrtc_bridge_unavailable");
    assert.match(payload.detail, /abort|timeout|operation/i);
    assert.equal(payload.readiness.readiness.pipecatWebrtcBridge.timeoutMs, 50);
    assert.equal(payload.readiness.contract.bridgeTimeoutMs, 50);
  } finally {
    if (previousBridgeUrl === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_URL;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_URL = previousBridgeUrl;
    }
    if (previousBridgeTimeout === undefined) {
      delete process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS;
    } else {
      process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS = previousBridgeTimeout;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});
