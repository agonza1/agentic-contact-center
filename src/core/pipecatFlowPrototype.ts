import type {
  CallSnapshot,
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

export const SCRIPTED_CALLER_TURNS = [
  "I want to cancel my policy today.",
  "The renewal increase is too high.",
  "Okay, what safe options can you review for me?",
  "Thanks, please note that follow-up and close the call.",
] as const;

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
  let matchedCallerTurns = 0;

  for (const [index, expectedTurn] of SCRIPTED_CALLER_TURNS.entries()) {
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
    expectedCallerTurns: [...SCRIPTED_CALLER_TURNS],
    matchedCallerTurns,
    completed: matchedCallerTurns === SCRIPTED_CALLER_TURNS.length,
  };
}

function buildSteeredResponse(action: OperatorSteerAction): string {
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

export function buildPipecatFlowPrototypeStatus(): PipecatFlowPrototypeStatus {
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
      expectedCallerTurns: [...SCRIPTED_CALLER_TURNS],
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
    ? "The local Pipecat runtime reported a failure, so I am failing closed and connecting you to a licensed retention specialist instead of improvising an offer or promising any billing credit."
    : "A required tool timed out, so I am failing closed and connecting you to a licensed retention specialist instead of improvising an offer or promising any billing credit.";

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
    const expectedTurn = SCRIPTED_CALLER_TURNS[snapshot.pipecatFlow.script.matchedCallerTurns] ?? null;

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

  if (callerTurnCount === 1) {
    snapshot.pipecatFlow.activeTool = "get_current_slide";
    transitionFlowState(snapshot, "greet", turn.timestamp, "caller_connected");
    appendAgentTurn(
      snapshot,
      "I can help with that. Before I review options, what is pushing you to cancel today?",
      turn.timestamp,
    );
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "cancellation_intent_captured");
    return;
  }

  if (callerTurnCount === 2) {
    snapshot.pipecatFlow.activeTool = "goto_slide";
    transitionFlowState(snapshot, "policy_hold", turn.timestamp, "risky_retention_boundary");
    recordEvent(snapshot, "policy_hold_entered", turn.timestamp, {
      reason: "renewal_increase_requires_safe_offer_review",
      toolScope: config.policy.toolScope,
    });
    appendAgentTurn(
      snapshot,
      "I heard the renewal increase concern. I am pausing before I discuss any retention offer so I stay within approved options.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 3) {
    snapshot.pipecatFlow.activeTool = "ask_operator";
    setOperatorSteerState(snapshot, true, turn.timestamp, config.policy.defaultSupervisorSteer, "safe_offer_review_requested");
    transitionFlowState(snapshot, "operator_steer", turn.timestamp, "safe_offer_review_requested");
    recordEvent(snapshot, "operator_steer_requested", turn.timestamp, {
      recommendation: config.policy.defaultSupervisorSteer,
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(
      snapshot,
      "I can review safe next steps once an operator approves the guidance path. I am holding here for supervisor steer.",
      turn.timestamp,
    );
    return;
  }

  if (callerTurnCount === 4) {
    snapshot.pipecatFlow.activeTool = "pause_presentation";
    transitionFlowState(snapshot, "wrap", turn.timestamp, "caller_confirmed_next_step");
    appendAgentTurn(
      snapshot,
      "I have documented the follow-up request and closed the demo call safely. Thank you for calling today.",
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

function buildFreeCallerAgentResponse(
  snapshot: CallSnapshot,
  text: string,
  callerTurnCount: number,
): { response: string; done: boolean; responseKind: string } {
  const normalized = normalizeText(text);
  const previousAgentTurns = priorAgentTurns(snapshot);

  if (/\b(thanks|thank you|bye|goodbye|that's all|that is all)\b/.test(normalized)) {
    return {
      response: "You are welcome. I have noted the conversation and I am closing the demo call now.",
      done: true,
      responseKind: "closing",
    };
  }

  if (/\b(human|agent|representative|operator|person|supervisor)\b/.test(normalized)) {
    return {
      response: "I can get a human involved. I will summarize what you told me so far and mark the call for operator follow-up.",
      done: false,
      responseKind: "handoff",
    };
  }

  if (/\b(bill|billing|charge|charged|payment|invoice|refund|renewal|price|cost)\b/.test(normalized)) {
    if (alreadyAsked(previousAgentTurns, "new charge, renewal increase, refund, or payment failure")) {
      return {
        response: "Thanks, I have the billing issue in context. The next useful step is to verify the account and review the charge details; if a credit or refund is needed, I would route that for approval instead of promising it here.",
        done: false,
        responseKind: "billing_followup",
      };
    }

    return {
      response: "I can help with the billing question. Is this about a new charge, a renewal increase, a refund, or a payment failure?",
      done: false,
      responseKind: "billing_clarify",
    };
  }

  if (/\b(cancel|cancellation|canceling|cancelled)\b/.test(normalized)) {
    if (alreadyAsked(previousAgentTurns, "why you want to cancel")) {
      return {
        response: "I have the cancellation concern in context. I can review approved next steps and, if this needs a policy decision, prepare a handoff summary for a specialist.",
        done: false,
        responseKind: "cancellation_followup",
      };
    }

    return {
      response: "I can help with a cancellation request. I will first understand why you want to cancel, then I can review approved options or connect you with the right specialist if the call needs a policy decision.",
      done: false,
      responseKind: "cancellation_clarify",
    };
  }

  if (/\b(address|email|phone|contact|name|update|change)\b/.test(normalized)) {
    return {
      response: "I can help update contact information. I would verify the account, confirm the new details back to you, and record the change request for the account workflow.",
      done: false,
      responseKind: "account_update",
    };
  }

  if (/\b(hours|open|close|location|office|website|app)\b/.test(normalized)) {
    return {
      response: "I can help with service information. Tell me the location, product, or account area you mean, and I will narrow the answer to that context.",
      done: false,
      responseKind: "service_info",
    };
  }

  if (callerTurnCount === 1) {
    return {
      response: "Hi, I am the local voice agent. I can help with billing, cancellation, account updates, or getting a human involved. What would you like to do next?",
      done: false,
      responseKind: "initial_capabilities",
    };
  }

  if (alreadyAsked(previousAgentTurns, "billing, cancellation, an account update, or a handoff")) {
    return {
      response: "I heard that additional detail. I will keep the existing context and move toward the safest next step: either answer within the demo scope or prepare a handoff if the request needs account access.",
      done: false,
      responseKind: "ambiguous_followup",
    };
  }

  return {
    response: "I heard you. To make sure I help correctly, can you tell me whether this is about billing, cancellation, an account update, or a handoff to a human?",
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

  if (callerTurnCount === 1) {
    transitionFlowState(snapshot, "greet", turn.timestamp, "free_caller_connected");
  } else if (done) {
    transitionFlowState(snapshot, "wrap", turn.timestamp, "free_caller_closed");
  } else {
    transitionFlowState(snapshot, "diagnose", turn.timestamp, "free_caller_conversation");
  }

  appendAgentTurn(snapshot, response, turn.timestamp);
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
  setOperatorSteerState(snapshot, false, timestamp, action, reason ?? null);
  appendOperatorTurn(snapshot, `operator steer: ${action}`, timestamp);
  recordEvent(snapshot, "operator_steer_applied", timestamp, {
    action,
    source: "mock_http_route",
    sourceRoute: audit.sourceRoute ?? null,
    confirmationAcknowledged: audit.confirmationAcknowledged ?? null,
  });

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
    setOperatorSteerState(snapshot, wasPending, timestamp, action, reason ?? null);
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
    setDemoFallback(snapshot, false, timestamp, null, snapshot.demoFallback.mode);
    transitionFlowState(snapshot, "operator_steer", timestamp, "operator_disarmed_manual_fallback");
    recordEvent(snapshot, "demo_fallback_disarmed", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
    });
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
    snapshot.pipecatFlow.activeTool = "ask_operator";
    return;
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
    recordEvent(snapshot, "operator_offer_denied", timestamp, {
      operatorChannel: snapshot.scenario.operatorChannel,
      source: "operator_steer",
    });
    transitionFlowState(snapshot, "steered_response", timestamp, "operator_denied_retention_offer");
    appendAgentTurn(snapshot, buildSteeredResponse(action), timestamp);
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
