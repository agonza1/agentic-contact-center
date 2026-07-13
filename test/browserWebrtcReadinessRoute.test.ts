import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("browser WebRTC bridge uses SmallWebRTCTransport with a real Pipecat Pipeline", () => {
  const bridge = readFileSync("scripts/pipecat-browser-webrtc-bridge.py", "utf8");

  assert.match(bridge, /SmallWebRTCRequestHandler/);
  assert.match(bridge, /SmallWebRTCTransport/);
  assert.match(bridge, /Pipeline\(\[/);
  assert.match(bridge, /transport\.input\(\)/);
  assert.match(bridge, /RtcAsrTurnProcessor\(session\)/);
  assert.match(bridge, /AccCallerTurnProcessor\(session\)/);
  assert.match(bridge, /KokoroTtsProcessor\(session\)/);
  assert.match(bridge, /transport\.output\(\)/);
  assert.match(bridge, /record_stage/);
  assert.match(bridge, /stt\.empty_transcript/);
  assert.match(bridge, /stageEvents/);
  assert.doesNotMatch(bridge, /RTCPeerConnection/);
  assert.doesNotMatch(bridge, /RTCSessionDescription/);
});

test("operator console polls browser WebRTC session proof for turn diagnostics", () => {
  const serverSource = readFileSync("src/http/createServer.ts", "utf8");

  assert.match(serverSource, /pollVoiceSessionProof/);
  assert.match(serverSource, /armVoiceSessionProofPolling/);
  assert.match(serverSource, /Audio reached the Pipecat bridge, but rtc-asr returned an empty transcript/);
  assert.match(serverSource, /rtc-asr transcript arrived/);
  assert.match(serverSource, /voiceLastProofTurnCount/);
  assert.match(serverSource, /await refresh\(\);/);
  assert.match(serverSource, /armVoiceSessionProofPolling\(\);/);
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
    assert.match(payload.readiness.pipecatWebrtcBridge.healthUrl, /\/health$/);
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
    assert.match(payload.nextActions[0] ?? "", /confirm .*\/health returns ok=true/);
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
  const bridgeRequests: Array<{ callId?: string; sdp?: string; type?: string; accUrl?: string }> = [];
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
      callId: string;
      type: string;
      sdp: string;
      iceServers: Array<{ urls: string }>;
      evidence: { mediaRecorderRequired: boolean; ffmpegRequired: boolean; stt: { engine: string }; tts: { engine: string } };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/browser-webrtc/session");
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
