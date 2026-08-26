export type ParallelLlmFeatureFlagState = "disabled" | "demo_enabled";

export interface ParallelLlmSharedStateItem {
  id: string;
  owner: "acc" | "pipecat" | "parallel_llm";
  handoffRule: string;
}

export interface ParallelLlmFailureMode {
  id: string;
  mitigation: string;
}

export interface ParallelLlmPathPlan {
  issue: "agonza1/agentic-contact-center#338";
  issueState: "closed";
  closedAt: "2026-08-13T21:43:46Z";
  status: "spike_recorded_no_active_runtime_lane";
  featureFlag: {
    env: "ACC_PARALLEL_LLM_PATH";
    state: ParallelLlmFeatureFlagState;
  };
  currentCriticalPath: string[];
  proposedParallelPath: string[];
  sharedState: ParallelLlmSharedStateItem[];
  cancellationBoundaries: string[];
  failureModes: ParallelLlmFailureMode[];
  fallbackBehavior: string;
  prototypeEntryPoint: string;
  verificationCommand: "npm run build && node --test dist/test/parallelLlmPathPlan.test.js";
}

function resolveFeatureFlag(env: NodeJS.ProcessEnv): ParallelLlmFeatureFlagState {
  return env.ACC_PARALLEL_LLM_PATH === "demo" ? "demo_enabled" : "disabled";
}

export function buildParallelLlmPathPlan(env: NodeJS.ProcessEnv = process.env): ParallelLlmPathPlan {
  return {
    issue: "agonza1/agentic-contact-center#338",
    issueState: "closed",
    closedAt: "2026-08-13T21:43:46Z",
    status: "spike_recorded_no_active_runtime_lane",
    featureFlag: {
      env: "ACC_PARALLEL_LLM_PATH",
      state: resolveFeatureFlag(env),
    },
    currentCriticalPath: [
      "transport.input",
      "rtc-asr final transcript",
      "ACC caller-turn request",
      "OpenAI structured proposal generation in openai_llm mode",
      "ACC proposal validation and FlowManager preview",
      "Pocket/Kokoro streaming TTS",
      "transport.output delivery acknowledgement",
    ],
    proposedParallelPath: [
      "Keep rtc-asr -> ACC caller-turn -> short safe response -> TTS on the realtime path.",
      "Fork committed transcript plus conversation-control snapshot to a cancellable background LLM task.",
      "Accept only fresh background results whose snapshotVersion and interruption epoch still match the live call.",
      "Queue accepted tool/deeper-reasoning results as the next-turn context instead of interrupting active audio.",
    ],
    sharedState: [
      {
        id: "committed_transcript",
        owner: "acc",
        handoffRule: "Send only delivery-acknowledged turns to the background LLM task.",
      },
      {
        id: "conversation_context",
        owner: "acc",
        handoffRule: "Include conversationControl, flowState, and snapshotVersion; reject stale results.",
      },
      {
        id: "tool_results",
        owner: "parallel_llm",
        handoffRule: "Return proposed tool results as pending context until ACC validates policy and idempotency.",
      },
      {
        id: "interruption_state",
        owner: "pipecat",
        handoffRule: "Cancel or mark background work stale when barge-in flushes the active output stream.",
      },
    ],
    cancellationBoundaries: [
      "caller barge-in before first audio delivery",
      "new committed caller turn supersedes the background task input",
      "operator takeover or human handoff",
      "FlowManager runtime failure or invalid transition",
    ],
    failureModes: [
      {
        id: "stale_llm_output",
        mitigation: "Drop responses whose snapshotVersion or interruption epoch no longer matches the live call.",
      },
      {
        id: "tool_delay",
        mitigation: "Keep the realtime voice path on a short safe reply and surface delayed tool context on a later turn.",
      },
      {
        id: "barge_in",
        mitigation: "Cancel active output and mark in-flight background proposals stale before they can update context.",
      },
      {
        id: "parallel_runtime_failure",
        mitigation: "Ignore the background result and continue the existing single-path behavior.",
      },
    ],
    fallbackBehavior: "When the flag is disabled or a parallel task fails, openai_llm mode keeps using the current single request/validation path.",
    prototypeEntryPoint: "future demo-only branch inside AccCallerTurnProcessor after delivery-ack snapshot commits",
    verificationCommand: "npm run build && node --test dist/test/parallelLlmPathPlan.test.js",
  };
}
