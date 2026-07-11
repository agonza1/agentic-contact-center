import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

function requestJson(port: number, route: string): Promise<{ statusCode: number; payload: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "GET",
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { collected += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, payload: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/pipecat-media-engine/readiness exposes the shared browser/SIP contract and honest SIP blocker", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await requestJson(address.port, "/api/pipecat-media-engine/readiness");
    assert.equal(response.statusCode, 200);

    const payload = response.payload;
    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/pipecat-media-engine/readiness");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#214");
    assert.equal(payload.status, "shared_contract_ready_sip_rtp_blocked");
    assert.equal(payload.reviewReady, false);
    assert.deepEqual(payload.validationCommands, [
      "npm test",
      "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
    ]);

    assert.equal(payload.sharedEngineContract.engine, "pipecat-ai");
    assert.equal(payload.sharedEngineContract.callTurnEngine, "rtc-asr -> ACC caller-turn -> Kokoro");
    assert.equal(payload.sharedEngineContract.normalizedAudioFrame.format, "pcm_s16le");
    assert.equal(payload.sharedEngineContract.normalizedAudioFrame.sipCodecBoundary.includes("PCMU/8000 RTP"), true);

    const adapters = payload.sharedEngineContract.requiredAdapters;
    assert.deepEqual(
      adapters.map((adapter: any) => adapter.id),
      ["browser_webrtc", "sip_freeswitch_rtp", "signalwire_sip_trunk"],
    );
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").implementedNow, true);
    assert.equal(adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp").implementedNow, false);
    assert.match(adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp").blocker, /not yet streamed bidirectionally/);
    assert.match(adapters.find((adapter: any) => adapter.id === "signalwire_sip_trunk").blocker, /past-call import remains out of scope/);

    assert.deepEqual(payload.reviewBlockers, [
      "FreeSWITCH RTP is not yet streamed bidirectionally through Pipecat frames; the current SIP bridge records/captures media, posts ACC events, and can attach rtc-asr evidence after capture.",
    ]);
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "browser_webrtc_uses_pipecat_rtc_asr_kokoro").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_freeswitch_uses_same_realtime_pipecat_engine").passed,
      false,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "signalwire_past_call_gap_explicit").passed,
      true,
    );
    assert.equal(payload.remainingWork.some((item: string) => item.includes("FreeSWITCH RTP adapter")), true);
    assert.deepEqual(payload.nextUnblockedSlice, {
      id: "sip_rtp_to_pipecat_input_frames",
      title: "Decode FreeSWITCH RTP into Pipecat input frames",
      adapter: "sip_freeswitch_rtp",
      entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      targetContract: "PCMU/8000 RTP -> PCM16 -> Pipecat InputAudioRawFrame -> rtc-asr final transcript",
      verification: "Add a deterministic RTP frame fixture that proves the bridge can emit Pipecat-compatible PCM16 input frames before wiring live playback.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
