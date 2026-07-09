import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

async function get(path: string): Promise<{ statusCode: number; body: string; contentType: string }> {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    return await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: address.port, path, method: "GET" }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            contentType: response.headers["content-type"] ?? "",
          });
        });
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

test("GET /api/cluecon exposes first-slice readiness, scenario, and proof metadata", async () => {
  const response = await get("/api/cluecon");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /application\/json/);

  const payload = JSON.parse(response.body) as {
    ok: boolean;
    workboardCard: string;
    routes: { scrollable: string; present: string; scriptedDemo: string };
    readiness: Array<{ id: string; status: string; caveat: string }>;
    scenario: { callerTurns: string[]; failureDrills: string[] };
    asrPanel: { contract: string; streamStates: string[]; fixtureEvents: Array<{ state: string }>; benchmarks: Array<{ label: string }> };
    brainBlocks: Array<{ file: string; affects: string[] }>;
    proofPreview: { compatibleRequest: string; includes: string[] };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.workboardCard, "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae");
  assert.equal(payload.routes.scrollable, "/cluecon");
  assert.equal(payload.routes.present, "/cluecon/present");
  assert.equal(payload.routes.scriptedDemo, "/api/demo/run-end-to-end");
  assert.ok(payload.readiness.some((item) => item.id === "pipecat" && item.status === "ready"));
  assert.ok(payload.readiness.some((item) => item.id === "rtc_asr" && /blocker state/.test(item.caveat)));
  assert.equal(payload.scenario.callerTurns.length, 4);
  assert.ok(payload.scenario.failureDrills.includes("tts_unavailable"));
  assert.equal(payload.asrPanel.contract, "PCM16 16 kHz mono in; transcript events out");
  assert.ok(payload.asrPanel.streamStates.includes("partial"));
  assert.ok(payload.asrPanel.fixtureEvents.some((event) => event.state === "error"));
  assert.ok(payload.asrPanel.benchmarks.some((benchmark) => benchmark.label === "first partial"));
  assert.ok(payload.brainBlocks.some((block) => block.file === "policy.md" && block.affects.includes("policy hold")));
  assert.equal(payload.proofPreview.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.ok(payload.proofPreview.includes.includes("ASR/TTS caveats"));
});

test("GET /cluecon and /cluecon/present render the interactive presentation shells", async () => {
  const narrative = await get("/cluecon");
  assert.equal(narrative.statusCode, 200);
  assert.match(narrative.contentType, /text\/html/);
  assert.match(narrative.body, /From SIP to Tokens/);
  assert.match(narrative.body, /Run scripted demo/);
  assert.match(narrative.body, /window\.__CLUECON__/);
  assert.match(narrative.body, /rtc-asr is measurable and swappable/);
  assert.match(narrative.body, /renderAsrPanel/);
  assert.match(narrative.body, /class="scroll"/);

  const present = await get("/cluecon/present");
  assert.equal(present.statusCode, 200);
  assert.match(present.body, /class="present"/);
  assert.match(present.body, /ArrowRight/);
});
