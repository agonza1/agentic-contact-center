import type {
  CallSnapshot,
  ConversationMode,
  EventTrailEntry,
  FlowState,
  FallbackMode,
  OperatorSteerAction,
  PipecatFlowPrototypeStatus,
  PocConfig,
  ScriptProgress,
  TranscriptTurn,
} from "./types";
import { defaultAssertEvaluationSpec } from "./assertEvaluationSpec";

export interface OpenAiLlmTurnResult {
  ok: boolean;
  model: string;
  text?: string;
  responseId?: string | null;
  error?: string;
  status?: number | null;
}

export const OPENAI_LIVE_SIP_FAIL_CLOSED_AGENT_TEXT =
  "I am having trouble with the live AI path, so I am stopping automated responses and connecting you to a licensed specialist.";

export const SCRIPTED_CALLER_TURNS = [
  "I'm thinking about canceling my policy.",
  "My renewal went up a lot, and I can't afford it.",
  "Is there anything you can do before I cancel?",
  "Okay, that sounds good. Thanks.",
] as const;

export const CLUECON_CANCELLATION_CALLER_TURNS = [
  "My account ends in 4821, and I want to cancel my plan.",
  "Yes, please check the price first.",
  "Yes, please cancel it.",
] as const;

export const CLUECON_CANCELLATION_AFTER_DENIAL_TURN = "Yes, please cancel it.";

export const PIPECAT_TOOL_COVERAGE = [
  "get_current_slide",
  "goto_slide",
  "pause_presentation",
  "ask_operator",
] as const;

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function recordEvent(
  snapshot: CallSnapshot,
  type: string,
  at: string,
  detail: EventTrailEntry["detail"],
): void {
  snapshot.events.push({ type, at, detail });
}

function transitionFlowState(
  snapshot: CallSnapshot,
  nextState: FlowState,
  at: string,
  reason: string,
): void {
  if (snapshot.flowState === nextState) {
    return;
  }

  recordEvent(snapshot, "flow_state_transition", at, {
    from: snapshot.flowState,
    to: nextState,
    reason,
  });
  snapshot.flowState = nextState;
}

function appendTranscriptTurn(snapshot: CallSnapshot, turn: TranscriptTurn): void {
  snapshot.transcript.push(turn);
  recordEvent(snapshot, `${turn.speaker}_turn_appended`, turn.timestamp, {
    flowState: snapshot.flowState,
    text: turn.text,
    transcriptLength: snapshot.transcript.length,
  });
}

function appendAgentTurn(snapshot: CallSnapshot, text: string, timestamp: string): void {
  appendTranscriptTurn(snapshot, {
    speaker: "agent",
    text,
    timestamp,
  });
}

function appendOperatorTurn(snapshot: CallSnapshot, text: string, timestamp: string): void {
  appendTranscriptTurn(snapshot, {
    speaker: "operator",
    text,
    timestamp,
  });
}

function computeScriptProgress(snapshot: CallSnapshot): ScriptProgress {
  const callerTurns = snapshot.transcript.filter((turn) => turn.speaker === "caller");
  const expectedTurns = snapshot.pipecatFlow.script.expectedCallerTurns;
  let matchedCallerTurns = 0;

  for (const [index, expectedTurn] of expectedTurns.entries()) {
    const actualTurn = callerTurns[index];
    if (!actualTurn) {
      break;
    }

    if (normalizeText(actualTurn.text) !== normalizeText(expectedTurn)) {
      break;
    }

    matchedCallerTurns += 1;
  }

  return {
    name: "cancellation_rescue_seeded_script",
    expectedCallerTurns: [...expectedTurns],
    matchedCallerTurns,
    completed: matchedCallerTurns === expectedTurns.length,
  };
}

function buildSteeredResponse(action: OperatorSteerAction): string {
  if (action === "approve_retention_review") {
    return "The review is complete, and I can't offer a lower price. Would you like me to go ahead and cancel the plan?";
  }

  if (action === "deny_offer") {
    return "Thanks for waiting. The operator did not approve a retention offer, so I cannot discuss a billing credit; I can document the concern or connect you with a licensed retention specialist.";
  }

  if (action === "escalate_to_human") {
    return "Thanks for waiting. I am connecting you to a licensed retention specialist because I cannot make an offer without human review, and I will not promise any billing credit on this call.";
  }

  if (action === "transfer") {
    return "Thanks for waiting. I am transferring this call to the supervised queue so a human operator can continue from the current context.";
  }

  if (action === "resume") {
    return "Thanks for waiting. I can resume the approved script and review safe next steps without promising any billing credit on this call.";
  }

  if (action === "arm_fallback") {
    return "Manual fallback is now armed. I will hold the scripted path until the operator decides whether to continue the live demo manually.";
  }

  if (action === "disarm_fallback") {
    return "Manual fallback is now disarmed. I can return to the scripted demo path when the operator is ready.";
  }

  return "Thanks for waiting. I can review approved next steps like a coverage fit check or a retention specialist follow-up, and I will not promise any billing credit on this call.";
}

function applyClueConCancellationFlow(
  snapshot: CallSnapshot,
  config: PocConfig,
  turn: TranscriptTurn,
  callerTurnCount: number,
): void {
  if (callerTurnCount === 1) {
    snapshot.pipecatFlow.activeTool = "goto_slide";
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "risky_retention_boundary");
    recordEvent(snapshot, "cancellation_concern_captured", turn.timestamp, {
      concern: "cancel_plan",
      source: "caller",
    });
    recordEvent(snapshot, "account_validated", turn.timestamp, {
      accountEnding: "4821",
      accountStatus: "active",
      sessionAuthenticated: true,
    });
    recordEvent(snapshot, "policy_hold_entered", turn.timestamp, {
      reason: "optional_price_review_requires_approval",
      toolScope: config.policy.toolScope,
    });
    appendAgentTurn(
      snapshot,
      "I found the plan on the account ending in 4821. Before I cancel it, would you like me to run a quick price review to see whether a lower price is available?",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 2) {
    snapshot.pipecatFlow.activeTool = "ask_operator";
    setOperatorSteerState(snapshot, true, turn.timestamp, "approve_retention_review", "price_review_requested");
    transitionFlowState(snapshot, "operator_steer", turn.timestamp, "price_review_requested");
    recordEvent(snapshot, "eligible_options_retrieved", turn.timestamp, {
      options: "same_call_price_review",
      discountGuaranteed: false,
    });
    recordEvent(snapshot, "customer_consent_recorded", turn.timestamp, {
      consent: "run_price_review",
      explicit: true,
    });
    recordEvent(snapshot, "operator_steer_requested", turn.timestamp, {
      recommendation: "approve_price_review",
      operatorChannel: snapshot.scenario.operatorChannel,
      operation: "same_call_price_review",
      maximumWaitSeconds: 60,
    });
    appendAgentTurn(
      snapshot,
      "Okay. I'll ask for approval to run the price review. This can take up to a minute, and your plan stays the same while I check.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount !== 3) return;

  const reviewApproved = snapshot.events.some((event) => event.type === "retention_review_approved");
  const reviewDenied = snapshot.events.some((event) => event.type === "retention_review_denied");
  snapshot.pipecatFlow.activeTool = "pause_presentation";

  if (reviewDenied) {
    recordEvent(snapshot, "customer_final_path_selected", turn.timestamp, {
      selection: "cancel_at_period_end_after_unavailable_review",
    });
    recordEvent(snapshot, "cancellation_scheduled", turn.timestamp, {
      effectiveDate: "2026-08-31",
      renewalDisabled: true,
      reversibleUntilEffectiveDate: true,
    });
    recordEvent(snapshot, "final_policy_state_recorded", turn.timestamp, {
      policyStatus: "active_through_2026-08-31",
      pendingOperation: "cancel_at_period_end",
      pricingChangeApplied: false,
      rollbackAvailable: true,
    });
    transitionFlowState(snapshot, "wrap", turn.timestamp, "cancellation_scheduled_after_unavailable_review");
    appendAgentTurn(
      snapshot,
      "Done. Your plan will stay active through August 31 and will not renew. You can change your mind before then.",
      turn.timestamp,
    );
    snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
    return;
  }

  if (!reviewApproved) {
    snapshot.pipecatFlow.activeTool = "ask_operator";
    transitionFlowState(snapshot, "operator_steer", turn.timestamp, "price_review_approval_required");
    appendAgentTurn(snapshot, "I'm still waiting for approval. Nothing has changed on your policy.", turn.timestamp);
    return;
  }

  recordEvent(snapshot, "customer_final_path_selected", turn.timestamp, {
    selection: "cancel_at_period_end_after_no_price_reduction",
  });
  recordEvent(snapshot, "cancellation_scheduled", turn.timestamp, {
    effectiveDate: "2026-08-31",
    renewalDisabled: true,
    reversibleUntilEffectiveDate: true,
  });
  recordEvent(snapshot, "final_policy_state_recorded", turn.timestamp, {
    policyStatus: "active_through_2026-08-31",
    pendingOperation: "cancel_at_period_end",
    pricingChangeApplied: false,
    rollbackAvailable: true,
  });
  transitionFlowState(snapshot, "wrap", turn.timestamp, "cancellation_scheduled_at_period_end");
  appendAgentTurn(
    snapshot,
    "Done. Your plan will stay active through August 31 and will not renew. You can change your mind before then.",
    turn.timestamp,
  );
  snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
}

function usesClueConCancellationFlow(config: PocConfig): boolean {
  return config.policy.defaultSupervisorSteer === "approve_retention_review";
}

function setDemoFallback(
  snapshot: CallSnapshot,
  armed: boolean,
  timestamp: string,
  reason: string | null,
  mode: FallbackMode | null,
): void {
  snapshot.demoFallback = {
    armed,
    reason,
    mode,
    armedAt: armed ? timestamp : snapshot.demoFallback.armedAt,
    disarmedAt: armed ? snapshot.demoFallback.disarmedAt : timestamp,
    source: "mock_http_route",
  };
}

function setOperatorSteerState(
  snapshot: CallSnapshot,
  pending: boolean,
  timestamp: string,
  action: OperatorSteerAction | null,
  reason: string | null,
): void {
  snapshot.operatorSteer = {
    pending,
    lastAction: action,
    lastReason: reason,
    requestedAt: pending ? timestamp : snapshot.operatorSteer.requestedAt,
    respondedAt: pending ? snapshot.operatorSteer.respondedAt : timestamp,
    source: action ? "mock_http_route" : snapshot.operatorSteer.source,
  };
}

export function buildPipecatFlowPrototypeStatus(
  defaultSupervisorSteer?: OperatorSteerAction,
): PipecatFlowPrototypeStatus {
  const expectedCallerTurns = defaultSupervisorSteer === "approve_retention_review"
    ? CLUECON_CANCELLATION_CALLER_TURNS
    : SCRIPTED_CALLER_TURNS;

  return {
    ready: true,
    prototypeMode: "pipecat_local_runtime",
    transport: "local_process",
    runtimeEngine: "pipecat-ai",
    credentialsMode: "mocked",
    runtimeCheck: {
      command: "npm run pipecat:check",
      installCommand: "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
      liveTelephonyRequired: false,
    },
    activeTool: "get_current_slide",
    toolCoverage: [...PIPECAT_TOOL_COVERAGE],
    script: {
      name: "cancellation_rescue_seeded_script",
      expectedCallerTurns: [...expectedCallerTurns],
      matchedCallerTurns: 0,
      completed: false,
    },
  };
}

export function getPipecatPrototypeHealth(): Pick<
  PipecatFlowPrototypeStatus,
  "ready" | "prototypeMode" | "transport" | "runtimeEngine" | "credentialsMode" | "runtimeCheck" | "activeTool" | "toolCoverage"
> {
  const status = buildPipecatFlowPrototypeStatus();
  return {
    ready: status.ready,
    prototypeMode: status.prototypeMode,
    transport: status.transport,
    runtimeEngine: status.runtimeEngine,
    credentialsMode: status.credentialsMode,
    runtimeCheck: status.runtimeCheck,
    activeTool: status.activeTool,
    toolCoverage: status.toolCoverage,
  };
}

export function triggerFailClosedFallback(
  snapshot: CallSnapshot,
  mode: FallbackMode,
  timestamp: string,
  reason?: string,
): void {
  const fallbackReason = reason?.trim() || mode;
  const handoffSource = mode === "runtime_failure" ? "pipecat_runtime_failure_fail_closed" : "tool_timeout_fail_closed";
  const agentMessage = mode === "runtime_failure"
    ? "The runtime reported a failure. I can't complete this safely or promise a billing credit, so I'll connect you with a licensed retention specialist."
    : "A required tool timed out. I can't complete this safely or promise a billing credit, so I'll connect you with a licensed retention specialist.";

  snapshot.pipecatFlow.activeTool = "pause_presentation";
  setDemoFallback(snapshot, true, timestamp, fallbackReason, mode);
  setOperatorSteerState(snapshot, false, timestamp, "escalate_to_human", `${mode}_fallback`);
  recordEvent(snapshot, "demo_fallback_triggered", timestamp, {
    mode,
    reason: fallbackReason,
    source: "mock_http_route",
  });
  transitionFlowState(snapshot, "policy_hold", timestamp, `${mode}_fallback_triggered`);
  recordEvent(snapshot, "human_handoff_started", timestamp, {
    operatorChannel: snapshot.scenario.operatorChannel,
    reason: fallbackReason,
    mode,
    source: handoffSource,
  });
  appendAgentTurn(snapshot, agentMessage, timestamp);
  transitionFlowState(snapshot, "wrap", timestamp, `${mode}_fallback_escalated`);
}

export function applyDeterministicPipecatFlow(
  snapshot: CallSnapshot,
  config: PocConfig,
  turn: TranscriptTurn,
): void {
  const callerTurns = snapshot.transcript.filter((entry) => entry.speaker === "caller");
  const callerTurnCount = callerTurns.length;

  snapshot.pipecatFlow.script = computeScriptProgress(snapshot);

  if (snapshot.pipecatFlow.script.matchedCallerTurns !== callerTurnCount) {
    const expectedTurn = snapshot.pipecatFlow.script.expectedCallerTurns[snapshot.pipecatFlow.script.matchedCallerTurns] ?? null;

    snapshot.pipecatFlow.activeTool = "ask_operator";
    setOperatorSteerState(snapshot, true, turn.timestamp, "ask_operator", "script_diverged");
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "script_diverged");
    recordEvent(snapshot, "script_diverged", turn.timestamp, {
      matchedCallerTurns: snapshot.pipecatFlow.script.matchedCallerTurns,
      expectedTurn,
      actualTurn: turn.text,
    });
    appendAgentTurn(
      snapshot,
      "This demo is tuned to the approved cancellation-rescue script. I am pausing here and requesting operator guidance before continuing.",
      turn.timestamp,
    );
    return;
  }

  if (usesClueConCancellationFlow(config)) {
    applyClueConCancellationFlow(snapshot, config, turn, callerTurnCount);
    return;
  }

  if (callerTurnCount === 1) {
    snapshot.pipecatFlow.activeTool = "get_current_slide";
    transitionFlowState(snapshot, "greet", turn.timestamp, "caller_connected");
    appendAgentTurn(
      snapshot,
      "I can help with that. May I ask what is prompting the cancellation?",
      turn.timestamp,
    );
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "cancellation_intent_captured");
    return;
  }

  if (callerTurnCount === 2) {
    snapshot.pipecatFlow.activeTool = "goto_slide";
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "risky_retention_boundary");
    recordEvent(snapshot, "cancellation_concern_captured", turn.timestamp, {
      concern: "renewal_increase_affordability",
      source: "caller",
    });
    recordEvent(snapshot, "policy_hold_entered", turn.timestamp, {
      reason: "renewal_increase_requires_safe_offer_review",
      toolScope: config.policy.toolScope,
    });
    if (config.policy.defaultSupervisorSteer !== "approve_retention_review") {
      recordEvent(snapshot, "eligible_options_retrieved", turn.timestamp, {
        options: "coverage_and_deductible_review,retention_specialist_review",
        discountGuaranteed: false,
      });
    }
    appendAgentTurn(
      snapshot,
      config.policy.defaultSupervisorSteer === "approve_retention_review"
        ? "I understand. I can check whether you're eligible for lower-cost coverage options or a retention review. You can still proceed with cancellation if those options don't help."
        : "I understand the renewal increase. I found an option to review your coverage and deductible. I can also request a retention specialist review, but that requires supervisor approval and does not guarantee a discount. Would you like me to request it? You can still proceed with cancellation.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 3) {
    if (config.policy.defaultSupervisorSteer === "approve_retention_review") {
      recordEvent(snapshot, "eligible_options_retrieved", turn.timestamp, {
        options: "coverage_and_deductible_review,retention_specialist_review",
        discountGuaranteed: false,
      });
      appendAgentTurn(
        snapshot,
        "I found an option to review your coverage and deductible. I can also request a retention specialist review, but that requires supervisor approval and does not guarantee a discount. Would you like me to request it?",
        turn.timestamp,
      );
      return;
    }
    snapshot.pipecatFlow.activeTool = "ask_operator";
    const approvalReason = "safe_offer_review_requested";
    setOperatorSteerState(snapshot, true, turn.timestamp, config.policy.defaultSupervisorSteer, approvalReason);
    transitionFlowState(snapshot, "operator_steer", turn.timestamp, approvalReason);
    recordEvent(snapshot, "operator_steer_requested", turn.timestamp, {
      recommendation: config.policy.defaultSupervisorSteer,
      operatorChannel: snapshot.scenario.operatorChannel,
      operation: "safe_options_guidance",
    });
    appendAgentTurn(
      snapshot,
      "Let me check which approved options I can discuss. This will not change your policy or guarantee a discount.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 4) {
    if (config.policy.defaultSupervisorSteer === "approve_retention_review") {
      snapshot.pipecatFlow.activeTool = "ask_operator";
      setOperatorSteerState(snapshot, true, turn.timestamp, "approve_retention_review", "retention_review_requested");
      transitionFlowState(snapshot, "operator_steer", turn.timestamp, "retention_review_requested");
      recordEvent(snapshot, "customer_consent_recorded", turn.timestamp, {
        consent: "request_retention_review",
        explicit: true,
      });
      recordEvent(snapshot, "operator_steer_requested", turn.timestamp, {
        recommendation: "approve_retention_review",
        operatorChannel: snapshot.scenario.operatorChannel,
        operation: "retention_specialist_review",
      });
      appendAgentTurn(
        snapshot,
        "Thanks. I'll request that approval now. Your policy remains unchanged while I wait.",
        turn.timestamp,
      );
      return;
    }
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    transitionFlowState(snapshot, "wrap", turn.timestamp, "caller_confirmed_next_step");
    appendAgentTurn(
      snapshot,
      "I have documented the follow-up request and closed the demo call safely. Thank you for calling today.",
      turn.timestamp,
    );
    snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
  }

  if (callerTurnCount === 5 && config.policy.defaultSupervisorSteer === "approve_retention_review") {
    const retentionReviewApproved = snapshot.events.some((event) => event.type === "retention_review_approved");
    const retentionReviewDenied = snapshot.events.some((event) => event.type === "retention_review_denied");
    if (retentionReviewDenied) {
      snapshot.pipecatFlow.activeTool = "pause_presentation";
      recordEvent(snapshot, "customer_final_path_selected", turn.timestamp, {
        selection: "continue_cancellation_after_denied_review",
      });
      recordEvent(snapshot, "human_handoff_started", turn.timestamp, {
        operatorChannel: snapshot.scenario.operatorChannel,
        reason: "retention_review_denied_customer_continued_cancellation",
        source: "scripted_flow",
      });
      recordEvent(snapshot, "final_policy_state_recorded", turn.timestamp, {
        policyStatus: "active",
        pendingOperation: "cancellation_handoff",
        pricingChangeApplied: false,
      });
      transitionFlowState(snapshot, "wrap", turn.timestamp, "customer_continued_cancellation_after_denial");
      appendAgentTurn(
        snapshot,
        "The retention review was not approved. Your policy remains active while I connect you with a licensed specialist to continue the cancellation. No pricing change has been applied.",
        turn.timestamp,
      );
      snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
      return;
    }
    if (!retentionReviewApproved) {
      snapshot.pipecatFlow.activeTool = "ask_operator";
      transitionFlowState(snapshot, "operator_steer", turn.timestamp, "retention_review_approval_required");
      appendAgentTurn(
        snapshot,
        "I still need approval before I can create the retention follow-up. Your policy remains unchanged while I wait.",
        turn.timestamp,
      );
      return;
    }
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    recordEvent(snapshot, "customer_final_path_selected", turn.timestamp, {
      selection: "keep_policy_active_pending_review",
    });
    recordEvent(snapshot, "retention_followup_created", turn.timestamp, {
      status: "requested",
      pricingChangeApplied: false,
    });
    recordEvent(snapshot, "final_policy_state_recorded", turn.timestamp, {
      policyStatus: "active",
      pendingOperation: "retention_review",
      pricingChangeApplied: false,
    });
    transitionFlowState(snapshot, "wrap", turn.timestamp, "customer_kept_policy_active_pending_review");
    appendAgentTurn(
      snapshot,
      "Done. Your policy remains active, and I've requested the retention follow-up. No pricing change has been promised or applied. You'll receive confirmation of the request.",
      turn.timestamp,
    );
    snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
  }
}

function priorAgentTurns(snapshot: CallSnapshot): string[] {
  return snapshot.transcript.filter((turn) => turn.speaker === "agent").map((turn) => normalizeText(turn.text));
}

function alreadyAsked(agentTurns: string[], fragment: string): boolean {
  const normalizedFragment = normalizeText(fragment);
  return agentTurns.some((text) => text.includes(normalizedFragment));
}

function callerHistory(snapshot: CallSnapshot): string {
  return normalizeText(snapshot.transcript.filter((turn) => turn.speaker === "caller").map((turn) => turn.text).join(" "));
}

function detectIntent(text: string): "billing" | "cancellation" | "account_update" | "handoff" | "service_info" | null {
  if (/\b(human|agent|representative|operator|person|supervisor)\b/.test(text)) return "handoff";
  if (/\b(bill|billing|charge|charged|payment|invoice|refund|renewal|price|cost)\b/.test(text)) return "billing";
  if (/\b(cancel|cancellation|canceling|cancelled|council)\b/.test(text)) return "cancellation";
  if (/\b(address|email|phone|contact|name|update|change)\b/.test(text)) return "account_update";
  if (/\b(hours|open|close|location|office|website|app)\b/.test(text)) return "service_info";
  return null;
}

function detectBillingSubtype(text: string): "charge" | "renewal" | "refund" | "payment" | null {
  if (/\b(refund|credit|money back)\b/.test(text)) return "refund";
  if (/\b(renewal|increase|went up|higher)\b/.test(text)) return "renewal";
  if (/\b(payment|card|paid|autopay|failed)\b/.test(text)) return "payment";
  if (/\b(charge|charged|invoice|bill)\b/.test(text)) return "charge";
  return null;
}

function isLowInformationTranscript(text: string): boolean {
  const withoutPunctuation = text.replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return withoutPunctuation.length <= 2 || words.length === 0 || /^[.\s]+$/.test(text);
}

function isCapabilitiesQuestion(text: string): boolean {
  return /\b(what can you do|what do you do|how can you help|what are my options)\b/.test(text);
}

function isAffirmativeResponse(text: string): boolean {
  return /\b(yes|yeah|yep|yup|please|sure|ok|okay|correct|sounds good|go ahead|do it|take over)\b/.test(text);
}

function buildFreeCallerAgentResponse(
  snapshot: CallSnapshot,
  text: string,
  callerTurnCount: number,
): { response: string; done: boolean; responseKind: string } {
  const normalized = normalizeText(text);
  const previousAgentTurns = priorAgentTurns(snapshot);
  const history = callerHistory(snapshot);
  const currentIntent = detectIntent(normalized);
  const historyIntent = detectIntent(history);
  const intent = currentIntent ?? historyIntent;
  const billingSubtype = detectBillingSubtype(normalized) ?? detectBillingSubtype(history);
  const cancellationReasonAsked =
    alreadyAsked(previousAgentTurns, "main reason you want to cancel") ||
    alreadyAsked(previousAgentTurns, "why you want to cancel");
  const humanSpecialistAsked = alreadyAsked(previousAgentTurns, "human specialist to take over");

  if (isLowInformationTranscript(normalized)) {
    return {
      response: "I didn’t catch that. Please say that again.",
      done: false,
      responseKind: "low_information_retry",
    };
  }

  if (isCapabilitiesQuestion(normalized)) {
    return {
      response: "I can help with billing, cancellation, account updates, service questions, or getting a human operator.",
      done: false,
      responseKind: "capabilities",
    };
  }

  if (/\b(thanks|thank you|bye|goodbye|that's all|that is all)\b/.test(normalized)) {
    return {
      response: "You are welcome. I noted the request and I am closing the demo call.",
      done: true,
      responseKind: "closing",
    };
  }

  if (alreadyAsked(previousAgentTurns, "what is the one thing you want them to solve first")) {
    return {
      response: "Got it. I’ll include that in the handoff summary and keep the call ready for an operator.",
      done: false,
      responseKind: "handoff_detail_captured",
    };
  }

  if (intent === "handoff") {
    return {
      response: "I’ll prepare a handoff summary for a human operator. What is the one thing you want them to solve first?",
      done: false,
      responseKind: "handoff",
    };
  }

  if (historyIntent === "cancellation" && cancellationReasonAsked) {
    if (humanSpecialistAsked && isAffirmativeResponse(normalized)) {
      return {
        response:
          "Understood. I have the cancellation reason and I am handing this to a human specialist now. I will stop automated responses here.",
        done: true,
        responseKind: "cancellation_handoff_confirmed",
      };
    }

    if (/\b(already said|said it|told you|i did)\b/.test(normalized)) {
      return {
        response: "You’re right, I have the cancellation reason. I can prepare safe options now or bring in a human specialist.",
        done: false,
        responseKind: "cancellation_reason_acknowledged",
      };
    }

    return {
      response: "I’ll mark that as the cancellation reason and prepare safe options. Do you want a human specialist to take over?",
      done: false,
      responseKind: "cancellation_reason_captured",
    };
  }

  if (intent === "billing") {
    if (billingSubtype) {
      if (alreadyAsked(previousAgentTurns, "what amount or date should i attach")) {
        return {
          response: `Thanks. I added that detail to the ${billingSubtype} review and will route anything needing approval to a human specialist.`,
          done: false,
          responseKind: `billing_${billingSubtype}_captured`,
        };
      }

      return {
        response: `Got it. I’ll start a ${billingSubtype} review. What amount or date should I attach to the case?`,
        done: false,
        responseKind: `billing_${billingSubtype}`,
      };
    }

    if (alreadyAsked(previousAgentTurns, "charge, renewal increase, refund, or payment issue")) {
      return {
        response: "No problem. I’ll open this as a general billing review. What amount or date do you see on the bill?",
        done: false,
        responseKind: "billing_general_review",
      };
    }

    return {
      response: "I can help. Is it a charge, renewal increase, refund, or payment issue?",
      done: false,
      responseKind: "billing_clarify",
    };
  }

  if (intent === "cancellation") {
    if (cancellationReasonAsked) {
      return {
        response: "I’ll mark this as a cancellation review and prepare safe options. Do you want a human specialist to take over?",
        done: false,
        responseKind: "cancellation_followup",
      };
    }

    return {
      response: "I can help with cancellation. What is the main reason you want to cancel?",
      done: false,
      responseKind: "cancellation_clarify",
    };
  }

  if (intent === "account_update") {
    return {
      response: "I can capture that account update. What detail should be changed?",
      done: false,
      responseKind: "account_update",
    };
  }

  if (intent === "service_info") {
    return {
      response: "I can help with service info. Which product or location should I check?",
      done: false,
      responseKind: "service_info",
    };
  }

  if (callerTurnCount === 1) {
    return {
      response: "Hi, I can help with billing, cancellation, account updates, or a human handoff. What do you need today?",
      done: false,
      responseKind: "initial_capabilities",
    };
  }

  if (alreadyAsked(previousAgentTurns, "billing, cancellation, an account update")) {
    return {
      response: "Let’s move this forward. I can start a billing review, cancellation review, account update, or human handoff. Pick one.",
      done: false,
      responseKind: "ambiguous_followup",
    };
  }

  return {
    response: "Is this billing, cancellation, an account update, or a human handoff?",
    done: false,
    responseKind: "ambiguous_clarify",
  };
}

export function applyFreeCallerPipecatFlow(snapshot: CallSnapshot, turn: TranscriptTurn): void {
  const callerTurnCount = snapshot.transcript.filter((entry) => entry.speaker === "caller").length;
  const { response, done, responseKind } = buildFreeCallerAgentResponse(snapshot, turn.text, callerTurnCount);

  snapshot.pipecatFlow.activeTool = done ? "pause_presentation" : "conversation_agent";
  snapshot.pipecatFlow.script = computeScriptProgress(snapshot);
  recordEvent(snapshot, "free_caller_turn_processed", turn.timestamp, {
    callerTurnCount,
    conversationMode: "free_caller",
    goalSpecId: defaultAssertEvaluationSpec.id,
    responseKind,
  });

  if (responseKind === "cancellation_handoff_confirmed") {
    recordEvent(snapshot, "human_handoff_started", turn.timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "free_caller_cancellation_confirmation",
    });
  }

  if (callerTurnCount === 1) {
    transitionFlowState(snapshot, "greet", turn.timestamp, "free_caller_connected");
  } else if (done) {
    transitionFlowState(snapshot, "wrap", turn.timestamp, "free_caller_closed");
  } else {
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "free_caller_conversation");
  }

  appendAgentTurn(snapshot, response, turn.timestamp);
}

export function applyOpenAiLlmPipecatFlow(
  snapshot: CallSnapshot,
  turn: TranscriptTurn,
  llm: OpenAiLlmTurnResult | undefined,
  options: { failClosedAlreadyPersisted?: boolean } = {},
): void {
  const callerTurnCount = snapshot.transcript.filter((entry) => entry.speaker === "caller").length;
  snapshot.pipecatFlow.script = computeScriptProgress(snapshot);

  if (!llm?.ok || !llm.text?.trim()) {
    if (!options.failClosedAlreadyPersisted) {
      applyOpenAiLlmFailClosedState(snapshot, turn, llm);
    }
    appendAgentTurn(snapshot, OPENAI_LIVE_SIP_FAIL_CLOSED_AGENT_TEXT, turn.timestamp);
    return;
  }

  snapshot.pipecatFlow.activeTool = "conversation_agent";
  recordEvent(snapshot, "openai_conversation_turn_processed", turn.timestamp, {
    conversationMode: "openai_llm",
    model: llm.model,
    responseId: llm.responseId ?? null,
    callerTurnCount,
    noScriptedFallback: true,
  });

  if (callerTurnCount === 1) {
    transitionFlowState(snapshot, "greet", turn.timestamp, "openai_llm_connected");
  } else {
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "openai_llm_conversation");
  }

  appendAgentTurn(snapshot, llm.text.trim(), turn.timestamp);
}

export function applyOpenAiLlmFailClosedState(
  snapshot: CallSnapshot,
  turn: TranscriptTurn,
  llm: OpenAiLlmTurnResult | undefined,
): void {
  const reason = llm?.error ?? "openai_llm_response_missing";
  snapshot.pipecatFlow.activeTool = "pause_presentation";
  setDemoFallback(snapshot, true, turn.timestamp, reason, "runtime_failure");
  setOperatorSteerState(snapshot, false, turn.timestamp, "escalate_to_human", "openai_llm_fail_closed");
  recordEvent(snapshot, "openai_conversation_generation_failed", turn.timestamp, {
    conversationMode: "openai_llm",
    model: llm?.model ?? "unknown",
    error: reason,
    status: llm?.status ?? null,
    noScriptedFallback: true,
  });
  recordEvent(snapshot, "human_handoff_started", turn.timestamp, {
    operatorChannel: snapshot.scenario.operatorChannel,
    reason,
    mode: "runtime_failure",
    source: "openai_llm_fail_closed",
  });
  transitionFlowState(snapshot, "wrap", turn.timestamp, "openai_llm_failed_closed");
}

export function isConversationMode(value: unknown): value is ConversationMode {
  return value === "scripted" || value === "free_caller" || value === "openai_llm";
}

export function applyOperatorSteer(
  snapshot: CallSnapshot,
  action: OperatorSteerAction,
  timestamp: string,
  reason?: string,
  audit: { sourceRoute?: string; confirmationAcknowledged?: boolean | null } = {},
): void {
  snapshot.pipecatFlow.activeTool = "ask_operator";
  const wasPending = snapshot.operatorSteer.pending;
  const pendingAction = snapshot.operatorSteer.lastAction;
  const pendingOperatorSteer = { ...snapshot.operatorSteer };
  setOperatorSteerState(snapshot, false, timestamp, action, reason ?? null);
  if (action !== "approve_retention_review") {
    appendOperatorTurn(snapshot, `operator steer: ${action}`, timestamp);
  }
  recordEvent(snapshot, "operator_steer_applied", timestamp, {
    action,
    reason: reason ?? null,
    pendingBeforeAction: wasPending,
    source: "mock_http_route",
    sourceRoute: audit.sourceRoute ?? null,
    confirmationAcknowledged: audit.confirmationAcknowledged ?? null,
  });

  if (action === "approve_retention_review") {
    recordEvent(snapshot, "retention_review_approved", timestamp, {
      reviewType: "same_call_price_review",
      discountGuaranteed: false,
      source: "operator_steer",
    });
    recordEvent(snapshot, "price_review_completed", timestamp, {
      result: "no_lower_price_available",
      reductionAvailable: false,
      pricingChangeApplied: false,
    });
    transitionFlowState(snapshot, "steered_response", timestamp, "retention_review_approved");
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    return;
  }

  if (action === "pause") {
    transitionFlowState(snapshot, "policy_hold", timestamp, "operator_paused_demo_flow");
    recordEvent(snapshot, "operator_demo_paused", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I am pausing the scripted demo flow here until an operator resumes or redirects the session.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "arm_fallback") {
    setDemoFallback(snapshot, true, timestamp, reason ?? "operator_requested_manual_takeover", null);
    if (wasPending) snapshot.operatorSteer = pendingOperatorSteer;
    transitionFlowState(snapshot, "policy_hold", timestamp, "operator_armed_manual_fallback");
    recordEvent(snapshot, "demo_fallback_armed", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      reason: snapshot.demoFallback.reason,
      pendingOperatorSteer: wasPending,
    });
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "disarm_fallback") {
    if (snapshot.demoFallback.armed) {
      setDemoFallback(snapshot, false, timestamp, null, snapshot.demoFallback.mode);
      if (!wasPending) transitionFlowState(snapshot, "steered_response", timestamp, "operator_disarmed_manual_fallback");
      recordEvent(snapshot, "demo_fallback_disarmed", timestamp, {
        operatorChannel: snapshot.scenario.operatorChannel,
      });
      appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    } else {
      recordEvent(snapshot, "demo_fallback_disarm_ignored", timestamp, {
        operatorChannel: snapshot.scenario.operatorChannel,
        reason: "fallback_not_armed",
      });
    }
    if (wasPending) snapshot.operatorSteer = pendingOperatorSteer;
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
  }

  if (action === "resume" && snapshot.demoFallback.armed) {
    setDemoFallback(snapshot, false, timestamp, null, snapshot.demoFallback.mode);
    recordEvent(snapshot, "demo_fallback_disarmed", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_resume",
    });
  }

  if (action === "goto_slide") {
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_requested_slide_redirect");
    recordEvent(snapshot, "operator_slide_redirect_requested", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I have the slide redirect request and I am holding for the operator-approved talking track before I continue.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "goto_slide";
    return;
  }

  if (action === "ask_operator") {
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_guidance_requested_explicitly");
    recordEvent(snapshot, "operator_guidance_re_requested", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I am explicitly asking the operator for guidance before I continue this demo call.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
  }

  if (action === "deny_offer") {
    const deniedRetentionReview = wasPending && pendingAction === "approve_retention_review";
    recordEvent(snapshot, "operator_offer_denied", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    if (deniedRetentionReview) {
      recordEvent(snapshot, "retention_review_denied", timestamp, {
        reviewType: "same_call_price_review",
        source: "operator_steer",
      });
      snapshot.pipecatFlow.script = {
        ...snapshot.pipecatFlow.script,
        expectedCallerTurns: [
          ...snapshot.pipecatFlow.script.expectedCallerTurns.slice(0, 2),
          CLUECON_CANCELLATION_AFTER_DENIAL_TURN,
        ],
      };
    }
    transitionFlowState(snapshot, "steered_response", timestamp, "operator_denied_retention_offer");
    appendAgentTurn(
      snapshot,
      deniedRetentionReview
        ? "I can't run the price review right now. Would you like me to go ahead and cancel the plan?"
        : buildSteeredResponse(action),
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
  }

  if (action === "escalate_to_human") {
    recordEvent(snapshot, "human_handoff_started", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    transitionFlowState(snapshot, "wrap", timestamp, "operator_escalated_to_human");
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "transfer") {
    recordEvent(snapshot, "operator_transfer_started", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    transitionFlowState(snapshot, "wrap", timestamp, "operator_transferred_to_human_queue");
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "takeover") {
    setDemoFallback(snapshot, true, timestamp, reason ?? "operator_barged_in", null);
    recordEvent(snapshot, "operator_takeover_started", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
      reason: snapshot.demoFallback.reason,
    });
    transitionFlowState(snapshot, "wrap", timestamp, "operator_took_over_live_call");
    appendAgentTurn(
      snapshot,
      "The operator has taken over this live call. I am stopping automated responses and handing the session to the human supervisor.",
      timestamp,
    );
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  if (action === "end_call") {
    recordEvent(snapshot, "operator_call_ended", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    transitionFlowState(snapshot, "wrap", timestamp, "operator_ended_live_call");
    appendAgentTurn(snapshot, "The operator ended the demo call and recorded a safe closeout.", timestamp);
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    return;
  }

  transitionFlowState(
    snapshot,
    "steered_response",
    timestamp,
    action === "resume" ? "operator_resumed_demo_flow" : "operator_guidance_available",
  );
  appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
}
