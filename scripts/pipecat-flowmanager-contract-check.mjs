import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { buildPipecatFlowManagerContractPayload } = require("../dist/src/core/pipecatFlowManagerContract.js");

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

const outputPath = resolveArgPath("--out");
const contract = buildPipecatFlowManagerContractPayload();

assert.equal(contract.sidecarFree, true);
assert.equal(contract.status, "parity_harness_defined_implementation_pending");
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
assert.ok(contract.parityChecks.some((check) => check.id === "runtime_failure_fail_closed"));
assert.ok(contract.parityFixtures.some((fixture) => fixture.id === "scripted_policy_hold" && fixture.expectedState === "policy_hold"));
assert.ok(contract.parityFixtures.some((fixture) => fixture.id === "operator_steer_handoff" && fixture.expectedEvents.includes("operator_steer_requested")));
assert.ok(contract.parityFixtures.every((fixture) => fixture.forbiddenAgentClaims.includes("billing credit")));

if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), contract }, null, 2)}\n`);
  console.log(`Saved Pipecat FlowManager contract artifact: ${outputPath}`);
}

console.log(`FlowManager contract: ${contract.requiredNodes.length} nodes, ${contract.requiredGuards.length} fail-closed guards, ${contract.parityChecks.length} parity checks`);
