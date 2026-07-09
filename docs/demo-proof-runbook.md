# Demo proof runbook

Use this runbook when you need a lightweight QA handoff artifact for the ClueCon cancellation-rescue demo.

## Generate proof

From the repo root:

```bash
npm install
npm test
npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

To gate the same proof on the local Pipecat package boundary first, install the optional runtime dependency and run:

```bash
python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt
npm run proof:pipecat -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

The proof command boots the local server on an ephemeral port, verifies a healthy `/health` response, runs the seeded scripted flow, runs the fail-closed `tool_timeout` fallback flow, and runs a `runtime_failure` fallback drill before writing reviewable JSON artifacts under `artifacts/`. The app still keeps live telephony and provider credentials mocked.

## What to inspect

Open `artifacts/demo-proof.json` or `artifacts/demo-proof-latest.json` and confirm:

- `summary.healthOk` is `true`
- `health.pipecatFlow.prototypeMode` is `pipecat_local_runtime`
- `health.pipecatFlow.credentialsMode` is `mocked`
- `summary.scripted.outcome` is `scripted_wrap_complete`
- `summary.scripted.flowState` is `wrap`
- `summary.scripted.latencyStages` includes `policy_hold_entered`
- `summary.scripted.eventTypes` includes `pipecat_runtime_turn_processed`
- `summary.fallback.outcome` is `fail_closed_handoff`
- `summary.fallback.mode` is `tool_timeout`
- `summary.fallback.reason` is `pipecat tool exceeded latency budget`
- `summary.fallback.eventTypes` includes `human_handoff_started`
- `summary.runtimeFailure.outcome` is `runtime_failure_fail_closed_handoff`
- `summary.runtimeFailure.mode` is `runtime_failure`
- `summary.runtimeFailure.reason` is `pipecat local runtime import failed`
- `summary.runtimeFailureSourceTrail.filteredSource` is `pipecat_runtime_failure_fail_closed`
- `summary.queueAttention.attentionRequired` is `1`
- `proofContract.queueAttentionFilter` scopes queue proof to `attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget`
- `proofContract.operatorNoteTrail` is `events?type=operator_note_recorded`
- `summary.operatorNoteTrail.latestDisposition` is `qa_verified`
- `proofContract.runtimeFailureSourceTrail` is `events?source=pipecat_runtime_failure_fail_closed`
- `proofContract.runtimeFailureCallListFilter` is `fallbackMode=runtime_failure&limit=5`
- `proofContract.runtimeFailureOperatorConsoleFilter` is `fallbackMode=runtime_failure&limit=1`
- `proofContract.runtimeFailureReasonQueueFilter`, `runtimeFailureReasonCallListFilter`, and `runtimeFailureReasonOperatorConsoleFilter` pin the fallback-reason QA filters for the runtime-failure drill
- `proofContract.runtimeFailureReasonEventTrail` points at the reason-filtered event trail for the runtime-failure drill
- `proofContract.runtimeFailureProofBundle` is `calls/{runtimeFailureCallId}/proof`
- `proofContract.runtimeFailureArtifactManifest` is `calls/{runtimeFailureCallId}/artifacts`
- `proofContract.runtimeFailureFallbackModeTranscriptTrail` is `calls/{runtimeFailureCallId}/transcript?speaker=agent&text=runtime%20reported%20a%20failure`
- `summary.runtimeFailureCallList.firstCallId` matches the runtime-failure drill call for targeted QA review
- `summary.runtimeFailureOperatorConsole.firstCallId` matches the same runtime-failure drill call in the operator console filter
- `summary.runtimeFailureReasonEvidence` proves the fallback-reason queue, call-list, operator-console, and event-trail filters all isolate the runtime-failure drill
- `summary.runtimeFailureProofBundle.fallbackReason` is `pipecat local runtime import failed`
- `summary.runtimeFailureProofBundle.fallbackSourceTrail` points at the runtime-failure handoff source trail
- `summary.runtimeFailureArtifactManifest.fallbackReason` is `pipecat local runtime import failed`
- `summary.runtimeFailureArtifactManifest.fallbackSourceTrail` points at the same runtime-failure handoff source trail from the artifact manifest
- `summary.runtimeFailureProofBundle.fallbackModeTranscriptTrail` and `summary.runtimeFailureArtifactManifest.fallbackModeTranscriptTrail` point at the runtime-failure transcript evidence route
- `summary.runtimeFailureProofBundle.fallbackModeOperatorConsole` and `summary.runtimeFailureArtifactManifest.fallbackModeOperatorConsole` point at `/api/operator/console?fallbackMode=runtime_failure&limit=1`
- `summary.queueAttention.oldestAttentionSource` is `fallback`
- `summary.queueAttention.oldestAttentionFlowState` is `wrap`
- `summary.queueAttention.oldestAttentionAgeMs` is a non-null number for stale-queue polling
- `summary.queueAttention.oldestAttentionStartedAt` is an ISO timestamp for the oldest attention item

When generating the proof through Docker Compose on Linux, run `LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose run --rm proof` so the bind-mounted `artifacts/` files stay writable by the invoking host user.

For deeper review, the full artifact also contains:

- transcript history for each scenario
- ordered event trail entries
- seeded latency marks
- final call snapshots for scripted wrap, fallback handoff, and runtime-failure handoff


## Generate proof bundle for ConversationAgentEvals

ACC integrates with [ConversationAgentEvals](https://github.com/agonza1/ConversationAgentEvals) through generated evidence, not through a runtime dependency. The ACC app and local proof scripts stay self-contained; the handoff file is `conversation-agent-evals-assert-request.json`, shaped as an `AssertRunCreateRequest` for a ConversationAgentEvals sidecar or review workflow.

After the Pipecat-gated proof run, create the evaluable bundle:

```bash
npm run proof:pipecat -- --out artifacts/agentic-call-center-demo/source-proof.json --latest-out artifacts/demo-proof-latest.json
npm run proof:bundle -- --proof artifacts/agentic-call-center-demo/source-proof.json --out-dir artifacts/agentic-call-center-demo
```

For a reproducible QA handoff timestamp, add `--generated-at 2026-06-29T17:00:00.000Z` or set `SOURCE_DATE_EPOCH` before running `npm run proof:bundle`.

Inspect `artifacts/agentic-call-center-demo/proof-bundle-manifest.json` and confirm it names:

- runtime labels: `pipecat_local_runtime`, `pipecat-ai`, `local_process`, `mocked`, and `rtc-asr local-stt.v1 contract replay`
- media artifacts: `media/caller-capture.wav`, both operator-console SVG screenshots, and `recordings/operator-console-demo.gif`
- evaluator ingress: `conversation-agent-evals-assert-request.json` shaped as an `AssertRunCreateRequest`
- limits: no production credentials, no live telephony, seeded local audio capture, and Local STT v1 contract replay unless `RTC_ASR_WS_URL` is supplied

Use `artifacts/agentic-call-center-demo/conversation-agent-evals-assert-request.json` as the handoff artifact for ConversationAgentEvals. It includes transcript, conversation, call media, action trace, final state, the full proof bundle, and Local STT v1 evidence.

This differs from the local ASSERT viewer workflow:

```bash
npm run assert:export
npm run assert:viewer
```

`npm run assert:export` writes local ASSERT viewer artifacts under `artifacts/results/agentic-contact-center-voice-demo/...`. `npm run proof:bundle` writes the ConversationAgentEvals request payload plus the evidence files it references.

For local SIP proof runs, `npm run proof:live-sip-bundle` also emits a `conversation-agent-evals-assert-request.json` in its selected output directory. That request is only review-ready when the live-capture manifest says `reviewReady: true`; generated self-tests and missing `rtc-asr` evidence are explicitly marked as blockers.

## QA handoff notes

Attach the stable `artifacts/demo-proof-latest.json` file to PR review or demo notes when you want a deterministic pointer. Keep timestamped artifacts when you need a point-in-time audit trail for multiple runs.
