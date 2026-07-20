# Voice Agent Reliability Reference Stack

This document is the Phase 1 #307 reliability-lab guide for Agentic Contact Center (ACC). It keeps the public story honest while Phase 2 wires the full ConversationAgentEvals/ASSERT lab profile.

## Ownership boundary

ACC is the WebRTC.ventures reference-stack entry point. It owns the cancellation-rescue target, local media adapters, operator control, readiness aggregation, proof bundles, and CAE-compatible evidence requests.

ACC does not own:

- ConversationAgentEvals generic spec editing, run orchestration, baselines, comparisons, or reports.
- rtc-asr model/backend implementation or ASR benchmark artifacts.
- ASSERT canonical judgment, scoring, or failure taxonomy.

Those projects stay independently usable and connect through URLs, artifacts, adapters, and evidence contracts.

## Modes

| Mode | Required components | Readiness vocabulary | Review proof |
| --- | --- | --- | --- |
| Scripted fixture demo | ACC only | `ready` when the local server/proof script passes | `artifacts/demo-proof-latest.json` |
| Browser voice | ACC, rtc-asr, Kokoro, Pipecat browser bridge | `configured`, `unreachable`, `degraded`, or `ready` per sidecar | `browser-webrtc:live-proof` evidence |
| SIP/Verto | ACC, FreeSWITCH, rtc-asr, Kokoro, Pipecat Verto bridge | `configured`, `unreachable`, `blocked`, or `ready` per service | `pipecat:verto:live-proof` manifest |
| Reliability lab | ACC plus configured CAE/ASSERT endpoints | Phase 1 reports `blocked` until external endpoints are supplied | Future CAE run/report links |

The default ACC scripted demo must remain independent of CAE, rtc-asr, FreeSWITCH, ASSERT, production credentials, and paid provider calls.

## Phase 1 status command

Run:

```bash
npm run reliability:lab
```

The command prints a JSON status report and does not start long-running services. It checks:

- package scripts required by #307 Phase 1;
- Compose profiles used by the documented modes;
- default ACC app route/port assumptions;
- component readiness states for default-demo, CAE, rtc-asr, Kokoro, FreeSWITCH/Verto, and ASSERT viewer wiring;
- whether optional CAE/ASSERT endpoint environment variables are configured;
- the current Phase 2 blockers.
- the endpoint environment contract in `repositoryContracts.optionalEndpointEnvVars`.

Environment variables recognized by the status command:

- `CAE_API_URL`
- `CAE_WEB_URL`
- `ASSERT_VIEWER_URL`
- `RTC_ASR_BASE_URL`
- `KOKORO_BASE_URL`
- `BROWSER_WEBRTC_BRIDGE_URL`
- `FREESWITCH_VERTO_URL`

Missing optional endpoints are reported as `not_configured` or `blocked`, not silently treated as ready.

## Phase 2 reliability-lab plan

The next implementation slice should add one explicit lab entry point that starts or connects:

1. ACC application.
2. Selected target media mode: fixture, browser WebRTC, or SIP/Verto.
3. rtc-asr and Kokoro when live media requires them.
4. ConversationAgentEvals API/web through configured external URLs or pinned images.
5. ASSERT through the ConversationAgentEvals boundary or local viewer.

Rules for Phase 2:

- Do not use git submodules.
- Do not copy ConversationAgentEvals, rtc-asr, or ASSERT source into ACC.
- Prefer pinned images or explicit service URLs.
- Keep CAE unavailability from breaking the normal ACC demo or operator console.
- Report `configured`, `reachable`, `ready`, `fixture`, `blocked`, and `not_required` separately.

## Phase 3 guided workflow plan

A future `/reliability` route should guide the user through:

1. Component readiness.
2. Baseline/candidate selection.
3. Fixture, browser, or SIP/Verto execution mode.
4. ACC proof bundle collection.
5. CAE run/deep-link submission.
6. ASSERT-backed report links.
7. Baseline versus controlled-candidate comparison.

It must be an integration guide, not a second generic evaluator product.
