import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { loadPocConfig } = require("../dist/src/config/loadPocConfig.js");
const { buildPipecatFlowManagerContractPayload } = require("../dist/src/core/pipecatFlowManagerContract.js");
const { replayPipecatFlowManagerParityFixtures } = require("../dist/src/core/pipecatFlowManagerParity.js");

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

const outputPath = resolveArgPath("--out");
const contract = buildPipecatFlowManagerContractPayload();
const parityReplays = await replayPipecatFlowManagerParityFixtures(loadPocConfig());

assert.equal(contract.sidecarFree, true);
assert.equal(contract.status, "node_handlers_mirrored_adapter_cutover_pending");
assert.equal(contract.parityHarnessCommand, "npm run pipecat:flows:contract");
assert.deepEqual(contract.requiredNodes, [
  "call_started",
  "greet",
  "diagnose",
  "policy_hold",
  "operator_steer",
  "steered_response",
  "wrap",
]);
assert.ok(contract.requiredGuards.some((guard) => guard.id === "policy_hold_before_retention_offer" && guard.failClosed));
assert.ok(contract.requiredGuards.some((guard) => guard.id === "operator_steer_required_for_safe_offer" && guard.failClosed));
assert.equal(contract.runtimePlan.status, "node_handlers_mirrored_adapter_cutover_pending");
assert.equal(contract.runtimePlan.adapterCutoverPending, true);
assert.deepEqual(contract.runtimePlan.missingRequiredNodes, []);
assert.deepEqual(contract.runtimePlan.nodeHandlers.map((handler) => handler.node), contract.requiredNodes);
assert.ok(contract.runtimePlan.nodeHandlers.find((handler) => handler.node === "policy_hold").guardIds.includes("operator_steer_required_for_safe_offer"));
assert.ok(contract.parityChecks.some((check) => check.id === "runtime_failure_fail_closed"));
assert.ok(contract.parityFixtures.some((fixture) => fixture.id === "scripted_policy_hold" && fixture.expectedState === "policy_hold"));
assert.ok(contract.parityFixtures.some((fixture) => fixture.id === "operator_steer_handoff" && fixture.expectedEvents.includes("operator_steer_requested")));
assert.ok(contract.parityFixtures.every((fixture) => fixture.forbiddenAgentClaims.includes("billing credit")));

const parityFixturesById = new Map(contract.parityFixtures.map((fixture) => [fixture.id, fixture]));
for (const parityCheck of contract.parityChecks) {
  const fixture = parityFixturesById.get(parityCheck.id);
  assert.ok(fixture, `missing parity fixture for ${parityCheck.id}`);
  assert.equal(fixture.expectedState, parityCheck.requiredState);
  assert.deepEqual(fixture.expectedEvents, parityCheck.requiredEvents);
}
assert.equal(parityReplays.length, contract.parityFixtures.length);
for (const replay of parityReplays) {
  assert.equal(replay.passed, true, `${replay.fixtureId} parity replay failed`);
  assert.deepEqual(replay.forbiddenAgentClaimsFound, []);
}

if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), contract, parityReplays }, null, 2)}\n`);
  console.log(`Saved Pipecat FlowManager contract artifact: ${outputPath}`);
}

console.log(`FlowManager contract: ${contract.requiredNodes.length} nodes, ${contract.requiredGuards.length} fail-closed guards, ${contract.parityChecks.length} parity checks`);
console.log(`FlowManager parity replay: ${parityReplays.filter((replay) => replay.passed).length}/${parityReplays.length} fixtures passed`);
