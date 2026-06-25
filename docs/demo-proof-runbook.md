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
- `summary.runtimeFailureSourceTrail.filteredSource` is `pipecat_runtime_failure_fail_closed`
- `summary.queueAttention.attentionRequired` is `1`
- `proofContract.queueAttentionFilter` scopes queue proof to `attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget`
- `proofContract.operatorNoteTrail` is `events?type=operator_note_recorded`
- `summary.operatorNoteTrail.latestDisposition` is `qa_verified`
- `proofContract.runtimeFailureSourceTrail` is `events?source=pipecat_runtime_failure_fail_closed`
- `proofContract.runtimeFailureCallListFilter` is `fallbackMode=runtime_failure&limit=5`
- `proofContract.runtimeFailureOperatorConsoleFilter` is `fallbackMode=runtime_failure&limit=1`
- `proofContract.runtimeFailureProofBundle` is `calls/{runtimeFailureCallId}/proof`
- `proofContract.runtimeFailureArtifactManifest` is `calls/{runtimeFailureCallId}/artifacts`
- `summary.runtimeFailureCallList.firstCallId` matches the runtime-failure drill call for targeted QA review
- `summary.runtimeFailureOperatorConsole.firstCallId` matches the same runtime-failure drill call in the operator console filter
- `summary.runtimeFailureProofBundle.fallbackSourceTrail` points at the runtime-failure handoff source trail
- `summary.runtimeFailureArtifactManifest.fallbackSourceTrail` points at the same runtime-failure handoff source trail from the artifact manifest
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

## QA handoff notes

Attach the stable `artifacts/demo-proof-latest.json` file to PR review or demo notes when you want a deterministic pointer. Keep timestamped artifacts when you need a point-in-time audit trail for multiple runs.
