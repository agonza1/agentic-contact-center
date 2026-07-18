import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(__dirname, "..", "..");

test("reliability lab status reports explicit blockers without starting sidecars", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.mode, "reliability_lab_phase_1_status");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.defaultDemo.status, "ready");
  assert.ok(payload.defaultDemo.notRequired.includes("ConversationAgentEvals"));
  assert.ok(payload.defaultDemo.notRequired.includes("rtc-asr"));
  assert.ok(payload.blockers.some((blocker: string) => blocker.includes("ConversationAgentEvals API/web endpoints")));
  assert.deepEqual(
    payload.componentReadiness.map((component: { component: string; status: string }) => [component.component, component.status]),
    [
      ["default-scripted-demo", "ready"],
      ["ConversationAgentEvals", "not_configured"],
      ["rtc-asr", "not_required"],
      ["Kokoro", "not_required"],
      ["FreeSWITCH/Verto", "not_required"],
      ["ASSERT viewer", "not_required"],
    ],
  );
  assert.ok(payload.repositoryContracts.packageScripts.includes("proof"));
  assert.ok(payload.repositoryContracts.composeProfiles.includes("browser-webrtc"));
  assert.ok(payload.repositoryContracts.reliabilityDocExists);
});

test("reliability lab status becomes configured when CAE endpoints are supplied", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAE_API_URL: "http://127.0.0.1:8010",
      CAE_WEB_URL: "http://127.0.0.1:3010",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.status, "configured");
  assert.deepEqual(payload.blockers, []);
  assert.equal(payload.optionalEndpoints.caeApi, "http://127.0.0.1:8010");
  assert.equal(payload.optionalEndpoints.caeWeb, "http://127.0.0.1:3010");
  assert.equal(
    payload.componentReadiness.find((component: { component: string }) => component.component === "ConversationAgentEvals").status,
    "configured",
  );
});
