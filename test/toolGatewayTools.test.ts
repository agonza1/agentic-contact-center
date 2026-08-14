import test from "node:test";
import assert from "node:assert/strict";

import {
  accToolDefinitions,
  getAccToolDefinition,
  isAccToolCallableByPrincipal,
  listAccToolsForPrincipal,
} from "../src/core/toolGatewayTools";

test("ACC tool manifest exposes only non-mutating tools to the voice agent", () => {
  const agentTools = listAccToolsForPrincipal("voice_agent").map((tool) => tool.name);

  assert.deepEqual(agentTools, ["retention.lookup_options", "operator.request_approval"]);
  assert.equal(isAccToolCallableByPrincipal("retention.lookup_options", "voice_agent"), true);
  assert.equal(isAccToolCallableByPrincipal("operator.request_approval", "voice_agent"), true);
  assert.equal(isAccToolCallableByPrincipal("retention.apply_offer", "voice_agent"), false);
});

test("operator-only offer application uses bounded primitive arguments", () => {
  const applyOffer = getAccToolDefinition("retention.apply_offer");
  const argumentNames = applyOffer.arguments.map((argument) => argument.name);
  const discountPercent = applyOffer.arguments.find((argument) => argument.name === "discount_percent");

  assert.deepEqual(applyOffer.principalTypes, ["operator"]);
  assert.deepEqual(argumentNames, ["call_id", "offer_id", "discount_percent", "approval_id", "idempotency_key"]);
  assert.equal(discountPercent?.minimum, 0);
  assert.equal(discountPercent?.maximum, 10);
  assert.equal(argumentNames.includes("role"), false);
  assert.equal(argumentNames.includes("operatorApproved"), false);
});

test("ACC tool manifest declares MCP annotations for each gateway tool", () => {
  assert.equal(accToolDefinitions.length, 3);
  assert.deepEqual(getAccToolDefinition("retention.lookup_options").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(getAccToolDefinition("operator.request_approval").annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(getAccToolDefinition("retention.apply_offer").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});
