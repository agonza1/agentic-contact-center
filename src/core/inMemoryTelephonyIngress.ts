import { applyDeterministicPipecatFlow, buildPipecatFlowPrototypeStatus } from "./pipecatFlowPrototype";
import type { CallSnapshot, PocConfig, TranscriptTurn } from "./types";

function cloneSnapshot(snapshot: CallSnapshot): CallSnapshot {
  return {
    session: { ...snapshot.session },
    scenario: { ...snapshot.scenario },
    pipecatFlow: {
      ...snapshot.pipecatFlow,
      toolCoverage: [...snapshot.pipecatFlow.toolCoverage],
      script: {
        ...snapshot.pipecatFlow.script,
        expectedCallerTurns: [...snapshot.pipecatFlow.script.expectedCallerTurns],
      },
    },
    flowState: snapshot.flowState,
    transcript: snapshot.transcript.map((turn) => ({ ...turn })),
    events: snapshot.events.map((event) => ({ ...event, detail: { ...event.detail } })),
    latencyBudgetsMs: { ...snapshot.latencyBudgetsMs },
  };
}

export class InMemoryTelephonyIngress {
  private readonly calls = new Map<string, CallSnapshot>();

  private nextCallSequence = 1;

  async startCall(config: PocConfig): Promise<CallSnapshot> {
    const sequence = this.nextCallSequence;
    this.nextCallSequence += 1;

    const paddedSequence = String(sequence).padStart(4, "0");
    const callId = `demo-call-${paddedSequence}`;
    const providerCallId = `${config.provider.callId}-${paddedSequence}`;
    const startedAt = new Date().toISOString();

    const snapshot: CallSnapshot = {
      session: {
        callId,
        demoName: config.demoName,
        providerName: config.provider.name,
        providerCallId,
        startedAt,
      },
      scenario: {
        name: config.demoName,
        mode: config.mode,
        policyProfile: config.policy.profile,
        defaultSupervisorSteer: config.policy.defaultSupervisorSteer,
        operatorChannel: config.operator.channel,
      },
      pipecatFlow: buildPipecatFlowPrototypeStatus(),
      flowState: "call_started",
      transcript: [],
      events: [
        {
          type: "call_bootstrapped",
          at: startedAt,
          detail: {
            providerCallId,
            mode: config.mode,
          },
        },
      ],
      latencyBudgetsMs: { ...config.latencyBudgetsMs },
    };

    this.calls.set(callId, snapshot);
    return cloneSnapshot(snapshot);
  }

  async appendCallerTurn(callId: string, turn: TranscriptTurn, config: PocConfig): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    snapshot.transcript.push({ ...turn });
    snapshot.events.push({
      type: "caller_turn_appended",
      at: turn.timestamp,
      detail: {
        speaker: turn.speaker,
        text: turn.text,
        transcriptLength: snapshot.transcript.length,
      },
    });

    applyDeterministicPipecatFlow(snapshot, config, turn);

    return cloneSnapshot(snapshot);
  }

  async getSnapshot(callId: string): Promise<CallSnapshot | null> {
    const snapshot = this.calls.get(callId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }
}
