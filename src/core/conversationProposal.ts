import type {
  ConversationIntent,
  ConversationNode,
  ConversationProposal,
  RequestedOperation,
} from "./types";

export const CONVERSATION_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "intent", "requestedOperation", "needsClarification", "slots", "proposedReply"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    intent: {
      type: "string",
      enum: ["cancellation", "billing", "account_update", "service_information", "human_handoff", "unsupported"],
    },
    requestedOperation: {
      anyOf: [
        {
          type: "string",
          enum: ["cancel_policy", "review_billing", "update_account", "get_service_information", "handoff"],
        },
        { type: "null" },
      ],
    },
    needsClarification: { type: "boolean" },
    slots: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: { reason: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
    proposedReply: { type: "string", minLength: 1, maxLength: 700 },
  },
} as const;

const INTENT_OPERATION: Record<ConversationIntent, RequestedOperation> = {
  cancellation: "cancel_policy",
  billing: "review_billing",
  account_update: "update_account",
  service_information: "get_service_information",
  human_handoff: "handoff",
  unsupported: null,
};

const INTENT_NODE: Record<ConversationIntent, ConversationNode> = {
  cancellation: "collect_identity",
  billing: "understand_billing",
  account_update: "collect_identity",
  service_information: "provide_service_information",
  human_handoff: "prepare_handoff",
  unsupported: "clarify_request",
};

const intents = new Set(Object.keys(INTENT_OPERATION));
const operations = new Set(["cancel_policy", "review_billing", "update_account", "get_service_information", "handoff"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConversationProposal(text: string):
  | { ok: true; proposal: ConversationProposal; targetNode: ConversationNode }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "openai_proposal_invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "openai_proposal_invalid_shape" };
  const keys = Object.keys(value).sort();
  const expectedKeys = ["intent", "needsClarification", "proposedReply", "requestedOperation", "schemaVersion", "slots"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, error: "openai_proposal_invalid_shape" };
  }
  const intent = value.intent;
  const requestedOperation = value.requestedOperation;
  const slots = value.slots;
  const proposedReply = value.proposedReply;
  if (
    value.schemaVersion !== 1
    || typeof intent !== "string"
    || !intents.has(intent)
    || (requestedOperation !== null && (typeof requestedOperation !== "string" || !operations.has(requestedOperation)))
    || typeof value.needsClarification !== "boolean"
    || !isRecord(slots)
    || Object.keys(slots).length !== 1
    || !("reason" in slots)
    || (slots.reason !== null && typeof slots.reason !== "string")
    || typeof proposedReply !== "string"
    || proposedReply.trim().length === 0
    || proposedReply.length > 700
  ) {
    return { ok: false, error: "openai_proposal_invalid_shape" };
  }
  const typedIntent = intent as ConversationIntent;
  const typedOperation = requestedOperation as RequestedOperation;
  if (INTENT_OPERATION[typedIntent] !== typedOperation) {
    return { ok: false, error: "openai_proposal_operation_mismatch" };
  }
  if ((typedIntent === "unsupported") !== value.needsClarification) {
    return { ok: false, error: "openai_proposal_clarification_mismatch" };
  }
  return {
    ok: true,
    proposal: {
      schemaVersion: 1,
      intent: typedIntent,
      requestedOperation: typedOperation,
      needsClarification: value.needsClarification,
      slots: { reason: slots.reason as string | null },
      proposedReply: proposedReply.trim(),
    },
    targetNode: INTENT_NODE[typedIntent],
  };
}
