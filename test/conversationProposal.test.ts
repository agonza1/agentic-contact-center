import test from "node:test";
import assert from "node:assert/strict";

import { parseConversationProposal } from "../src/core/conversationProposal";

test("ACC maps a valid cancellation proposal to identity collection", () => {
  const parsed = parseConversationProposal(JSON.stringify({
    schemaVersion: 1,
    intent: "cancellation",
    requestedOperation: "cancel_policy",
    needsClarification: false,
    slots: { reason: "renewal increased" },
    proposedReply: "I can help with that. First, please provide the account holder's full name and ZIP code.",
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.targetNode, "collect_identity");
  assert.equal(parsed.proposal.intent, "cancellation");
});

test("ACC rejects malformed and semantically mismatched proposals", () => {
  assert.deepEqual(parseConversationProposal("not json"), {
    ok: false,
    error: "openai_proposal_invalid_json",
  });
  assert.deepEqual(parseConversationProposal(JSON.stringify({
    schemaVersion: 1,
    intent: "cancellation",
    requestedOperation: "review_billing",
    needsClarification: false,
    slots: { reason: null },
    proposedReply: "I can help.",
  })), {
    ok: false,
    error: "openai_proposal_operation_mismatch",
  });
});
