import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /api/browser-webrtc/readiness exposes issue 213 WebRTC route contract", async () => {
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
        pipecatWebrtcBridge: { status: string; bridgeUrl: string; failClosedWhenUnavailable: boolean };
        rtcAsr: { status: string; engine: string; contract: string };
        kokoro: { status: string; engine: string };
      };
      legacyChunkBridge: {
        status: string;
        mediaRecorderRequired: boolean;
        ffmpegRequired: boolean;
        intendedForNormalBrowserVoice: boolean;
      };
      contract: {
        signalingRoute: string;
        readinessRoute: string;
        sidecars: { stt: string; tts: string };
      };
      preservation: Record<string, boolean | string>;
      acceptanceProgress: Array<{ criterion: string; passed: boolean; evidence: string }>;
      blockers: string[];
      nextActions: string[];
      validationCommands: string[];
      contractReady: boolean;
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/browser-webrtc/readiness");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#213");
    assert.equal(payload.status, "ready_for_pipecat_webrtc_bridge");
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
    assert.match(payload.readiness.pipecatWebrtcBridge.bridgeUrl, /127\.0\.0\.1:8766/);
    assert.deepEqual(payload.readiness.rtcAsr, {
      status: "contract_ready",
      engine: "rtc-asr",
      contract: "local-stt.v1",
    });
    assert.deepEqual(payload.readiness.kokoro, {
      status: "contract_ready",
      engine: "kokoro",
    });
    assert.deepEqual(payload.legacyChunkBridge, {
      status: "isolated_legacy",
      command: "npm run pipecat:voice",
      transport: "websocket_binary_webm_chunks",
      mediaRecorderRequired: true,
      ffmpegRequired: true,
      intendedForNormalBrowserVoice: false,
      note: "Retained only as legacy local proof plumbing; normal browser voice uses WebRTC signaling and does not fall back to this path.",
    });
    assert.equal(payload.contract.signalingRoute, "POST /api/browser-webrtc/session");
    assert.equal(payload.contract.readinessRoute, "/api/browser-webrtc/readiness");
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
        live_webrtc_media_turn: true,
      },
    );
    assert.deepEqual(payload.blockers, []);
    assert.match(payload.nextActions[0] ?? "", /Pipecat WebRTC bridge/);
    assert.deepEqual(payload.validationCommands, ["npm test"]);
    assert.equal(payload.contractReady, true);
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
    assert.match(payload.sdp, /^v=0/);
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
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
  }
});
