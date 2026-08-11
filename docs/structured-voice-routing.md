# Structured voice routing on extension 8600

Extension `8600` now implements the first production-shaped conversation-control slice. It turns an ASR final transcript into a typed proposal, validates that proposal in ACC, and moves the Pipecat conversation graph to an allowed node. It deliberately does not verify identity, authorize an account operation, or mutate business state.

```text
speech -> ASR final -> LLM request proposal -> ACC validation -> Pipecat Flow node
                                                               -> short TTS reply
```

## Ownership boundary

- The LLM proposes `intent`, `requestedOperation`, clarification state, a small slot set, and a short reply.
- ACC strictly validates the schema, checks the intent/operation pairing, applies the output guardrail, and selects the next node.
- Pipecat `FlowManager` owns the conversation-node transition. The transition is staged during preview and committed only after first audio is delivered and ACC receives the delivery acknowledgement.
- Codex delivery previews use a stateless thread seeded from ACC's committed transcript, so canceled or zero-audio output cannot leak into the next model turn.
- ACC remains authoritative for identity, customer/account data, approvals, tools, and resulting business state.

The first graph routes `understand_request` to one of:

| Validated proposal | Conversation node |
| --- | --- |
| cancellation or account update | `collect_identity` |
| billing | `understand_billing` |
| service information | `provide_service_information` |
| requested human help | `prepare_handoff` |
| unsupported or unclear request | `clarify_request` |

The model does not emit a node name. ACC derives it from the validated intent. A malformed proposal, mismatched operation, output-guardrail violation, or model failure is rejected and routed to `prepare_handoff` through the existing fail-closed path.

## Evidence

The call snapshot exposes `conversationControl.node`, the last proposal, and the authoritative decision. The event trail records `conversation_intent_proposed`, `conversation_proposal_accepted`, or `conversation_proposal_rejected`. Each decision explicitly records that no business state changed in this slice. The operator console shows the active conversation node beside the legacy operational flow state.

## Non-goals for this slice

No identity lookup, approval, plan change, cancellation, payment action, or other consequential tool is wired to the model. Those handlers belong in later slices and must re-read authoritative state, validate policy, use idempotency, and record the outcome before returning the next node.
