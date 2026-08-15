import test from "node:test";
import assert from "node:assert/strict";

import {
  accToolDefinitions,
  getAccToolDefinition,
  isAccToolCallableByPrincipal,
  listAccMcpToolsForPrincipal,
  listAccToolsForPrincipal,
  validateAccToolArguments,
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

test("ACC MCP tools/list manifest hides operator-only tools from the voice agent", () => {
  const agentManifest = listAccMcpToolsForPrincipal("voice_agent");
  const operatorManifest = listAccMcpToolsForPrincipal("operator");

  assert.deepEqual(agentManifest.map((tool) => tool.name), ["retention.lookup_options", "operator.request_approval"]);
  assert.deepEqual(operatorManifest.map((tool) => tool.name), [
    "retention.lookup_options",
    "operator.request_approval",
    "retention.apply_offer",
  ]);
  assert.equal(JSON.stringify(agentManifest).includes("retention.apply_offer"), false);
});

test("ACC MCP tools/list manifest exports bounded primitive input schemas", () => {
  const [requestApproval] = listAccMcpToolsForPrincipal("voice_agent")
    .filter((tool) => tool.name === "operator.request_approval");
  const [applyOffer] = listAccMcpToolsForPrincipal("operator")
    .filter((tool) => tool.name === "retention.apply_offer");

  assert.deepEqual(requestApproval.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      call_id: { type: "string" },
      offer_id: { type: "string" },
      discount_percent: { type: "number", minimum: 0, maximum: 10 },
      idempotency_key: { type: "string" },
    },
    required: ["call_id", "offer_id", "discount_percent", "idempotency_key"],
  });
  assert.equal(applyOffer.inputSchema.additionalProperties, false);
  assert.equal(applyOffer.inputSchema.properties.discount_percent.maximum, 10);
  assert.equal(Object.hasOwn(applyOffer.inputSchema.properties, "operatorApproved"), false);
  assert.equal(Object.hasOwn(applyOffer.inputSchema.properties, "role"), false);
});

test("ACC MCP tools/list manifest exports self-contained schema and annotation objects", () => {
  const [lookupOptions] = listAccMcpToolsForPrincipal("voice_agent")
    .filter((tool) => tool.name === "retention.lookup_options");
  const definition = getAccToolDefinition("retention.lookup_options");

  assert.notEqual(lookupOptions.annotations, definition.annotations);
  assert.deepEqual(Object.keys(lookupOptions.inputSchema.properties), lookupOptions.inputSchema.required);

  lookupOptions.annotations.readOnlyHint = false;

  assert.equal(getAccToolDefinition("retention.lookup_options").annotations.readOnlyHint, true);
});

test("ACC tool argument validation normalizes only the declared primitive gateway shape", () => {
  const validation = validateAccToolArguments("retention.apply_offer", {
    call_id: "call-123",
    offer_id: "retention-10",
    discount_percent: 10,
    approval_id: "approval-123",
    idempotency_key: "idem-123",
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.normalizedArguments, {
    call_id: "call-123",
    offer_id: "retention-10",
    discount_percent: 10,
    approval_id: "approval-123",
    idempotency_key: "idem-123",
  });
});

test("ACC tool argument validation rejects escalation flags and out-of-bound offers", () => {
  const validation = validateAccToolArguments("retention.apply_offer", {
    call_id: "call-123",
    offer_id: "retention-25",
    discount_percent: 25,
    approval_id: "approval-123",
    idempotency_key: "idem-123",
    operatorApproved: true,
    role: "operator",
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors, [
    { argumentName: "discount_percent", reason: "argument_out_of_bounds" },
    { argumentName: "operatorApproved", reason: "unknown_argument" },
    { argumentName: "role", reason: "unknown_argument" },
  ]);
  assert.deepEqual(Object.keys(validation.normalizedArguments), [
    "call_id",
    "offer_id",
    "approval_id",
    "idempotency_key",
  ]);
});

test("ACC tool argument validation rejects missing and non-primitive required arguments", () => {
  const validation = validateAccToolArguments("operator.request_approval", {
    call_id: "call-123",
    offer_id: "retention-10",
    discount_percent: "10",
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors, [
    { argumentName: "discount_percent", reason: "invalid_argument_type" },
    { argumentName: "idempotency_key", reason: "missing_required_argument" },
  ]);
});
