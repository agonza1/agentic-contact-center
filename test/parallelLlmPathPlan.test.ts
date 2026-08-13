import test from "node:test";
import assert from "node:assert/strict";

import { buildParallelLlmPathPlan } from "../src/core/parallelLlmPathPlan";

test("parallel LLM path plan is disabled by default and keeps current fallback behavior", () => {
  const plan = buildParallelLlmPathPlan({});

  assert.equal(plan.issue, "agonza1/agentic-contact-center#338");
  assert.equal(plan.status, "proposal_locked_pending_runtime_spike");
  assert.deepEqual(plan.featureFlag, {
    env: "ACC_PARALLEL_LLM_PATH",
    state: "disabled",
  });
  assert.equal(plan.currentCriticalPath.includes("OpenAI structured proposal generation in openai_llm mode"), true);
  assert.match(plan.fallbackBehavior, /current single request\/validation path/);
  assert.equal(plan.verificationCommand, "npm run build && node --test dist/test/parallelLlmPathPlan.test.js");
});

test("parallel LLM path plan records shared state, cancellation, and stale-output guards", () => {
  const plan = buildParallelLlmPathPlan({ ACC_PARALLEL_LLM_PATH: "demo" });

  assert.equal(plan.featureFlag.state, "demo_enabled");
  assert.equal(plan.sharedState.find((item) => item.id === "committed_transcript")?.owner, "acc");
  assert.match(
    plan.sharedState.find((item) => item.id === "committed_transcript")?.handoffRule ?? "",
    /delivery-acknowledged/,
  );
  assert.equal(plan.sharedState.find((item) => item.id === "interruption_state")?.owner, "pipecat");
  assert.ok(plan.cancellationBoundaries.includes("caller barge-in before first audio delivery"));
  assert.match(
    plan.failureModes.find((mode) => mode.id === "stale_llm_output")?.mitigation ?? "",
    /snapshotVersion/,
  );
  assert.match(
    plan.proposedParallelPath.join(" "),
    /short safe response/,
  );
});
