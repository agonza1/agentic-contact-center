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

| Mode | Target mode id | Start command | Validation command | Evidence command | CAE handoff command | Required components | Readiness vocabulary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scripted fixture demo | `fixture` | `npm run proof` | `npm run proof` | `npm run proof:bundle` | `npm run cae:assert:handoff` | ACC only | `ready` when the local server/proof script passes |
| Browser voice | `browser_webrtc` | `npm run docker:browser-webrtc` | `npm run browser-webrtc:check` | `npm run browser-webrtc:live-proof` | `npm run cae:assert:handoff` | ACC, rtc-asr, Kokoro, Pipecat browser bridge | `configured`, `unreachable`, `degraded`, or `ready` per sidecar |
| SIP/Verto | `sip_verto` | `npm run docker:sip-verto` | `npm run pipecat:verto:check` | `npm run pipecat:verto:live-proof` | `npm run cae:assert:handoff` | ACC, FreeSWITCH, rtc-asr, Kokoro, Pipecat Verto bridge | `configured`, `unreachable`, `blocked`, or `ready` per service |
| Reliability lab | `reliability_lab` | `npm run docker:reliability-lab` | `npm run reliability:lab` | `npm run proof:bundle` | `npm run cae:assert:handoff` | ACC plus configured CAE/ASSERT endpoints | Phase 1 reports `blocked` until external endpoints are supplied |
| SignalWire PSTN | `signalwire_pstn` | `npm run docker:sip-verto` | `npm run signalwire:freeswitch:readiness` | `npm run signalwire:freeswitch:readiness -- --render` | `npm run cae:assert:handoff` | ACC, SignalWire SIP trunk, public FreeSWITCH/Verto, rtc-asr, Kokoro, Pipecat Verto bridge | `blocked` until trunk, source ACL, public SIP reachability, and live media endpoints are validated |

The default ACC scripted demo must remain independent of CAE, rtc-asr, FreeSWITCH, ASSERT, production credentials, and paid provider calls.

## Phase 1 status command

Run:

```bash
npm run reliability:lab
```

The command prints a JSON status report and does not start long-running services. It checks:

- package scripts required by #307 Phase 1;
- Compose profiles used by the documented modes;
- the `stack/versions.env` reference-stack image and endpoint manifest;
- default ACC app route/port assumptions;
- component readiness states for default-demo, CAE, rtc-asr, Kokoro, FreeSWITCH/Verto, and ASSERT viewer wiring;
- whether optional CAE/ASSERT endpoint environment variables are configured and reachable;
- the current Phase 2 blockers.
- the endpoint environment contract in `repositoryContracts.optionalEndpointEnvVars`.
- the CAE/ASSERT handoff checklist in `handoffChecklist`, including selected-mode, controlled-candidate, live-media, and request-generation evidence gates.
- the concrete artifact inventory in `evidenceInventory`, mapping each fixture, CAE handoff, browser, SIP/Verto, and SignalWire proof artifact to its producer command and validation signals.
- the selected mode artifact presence, size, last update time, and age in milliseconds in `selectedTargetMode.evidenceStatus`, plus `selectedTargetMode.nextMissingEvidence` for the next proof command to run.
- explicit `handoffReady` and `handoffBlockers` fields on `selectedTargetMode`, `selectedRunProfile`, and their evidence summaries, so runners can block CAE/ASSERT handoff on missing or stale artifacts without scraping row details.
- the evidence-specific next step in `selectedTargetMode.nextEvidenceAction` and `selectedRunProfile.nextEvidenceAction`, so an orchestrator can capture the next missing artifact before rerunning the broader validation gate.
- the lab run-profile contract in `runProfiles`, covering local fixture, connected CAE, and live-media lab runs.
- the selected run profile in `selectedRunProfile`, mapping `ACC_RELIABILITY_TARGET_MODE` to the smallest profile and next validation command.
- the selected run profile artifact status, including artifact age in milliseconds, in `selectedRunProfile.evidenceStatus` and `selectedRunProfile.evidenceSummary`, so an orchestrator can see whether the profile's required artifacts already exist.
- the selected `labEntryPoint`, also available through `npm run reliability:entrypoint`, with ordered start/connect, readiness, evidence, and CAE handoff commands for the chosen target mode.

Environment variables recognized by the status command:

- `ACC_RELIABILITY_TARGET_MODE`
- `CAE_API_URL`
- `CAE_WEB_URL`
- `ASSERT_VIEWER_URL`
- `RTC_ASR_BASE_URL`
- `KOKORO_BASE_URL`
- `BROWSER_WEBRTC_BRIDGE_URL`
- `FREESWITCH_VERTO_URL`

Readiness vocabulary:

- `blocked`
- `configured`
- `degraded`
- `fixture`
- `missing`
- `not_configured`
- `not_required`
- `reachable`
- `ready`
- `unreachable`

Missing optional endpoints are reported as `not_configured` or `blocked`, not silently treated as ready.
Per-mode `endpointStatus[]` entries use `missing` for an individual endpoint environment variable that has not been supplied yet.
Configured endpoints are probed with a short timeout and reported as `ready` or `unreachable`; set `ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS` to tune the bounded probe during local diagnostics.
`fixture`, `reachable`, and `degraded` are reserved vocabulary terms for mode summaries and future endpoint probes, so generated status consumers do not have to infer them from prose.
`ACC_RELIABILITY_TARGET_MODE` selects the machine-readable `selectedTargetMode` in both `npm run reliability:lab` and `/api/reliability`; when unset, the safe sidecar-free `fixture` mode is selected.

`stack/versions.env` is the pinned local reference manifest. It names the ACC, rtc-asr, Kokoro, FreeSWITCH, browser bridge, ToolHive gateway, CAE, and ASSERT image/URL or version coordinates that Phase 2 should either start through Compose or connect to explicitly.

## Evidence inventory

The status API and command expose the same `evidenceInventory` records. Keep this table aligned with that contract so operators can capture the next missing artifact without scraping prose.

| Evidence id | Required for | Artifact | Producer command |
| --- | --- | --- | --- |
| `controlled_candidate_proof` | `fixture`, `browser_webrtc`, `reliability_lab`, `sip_verto`, `signalwire_pstn` | `artifacts/demo-proof-latest.json` | `npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json` |
| `cae_assert_request` | `fixture`, `browser_webrtc`, `reliability_lab`, `sip_verto`, `signalwire_pstn` | `artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json` | `npm run cae:assert:handoff` |
| `browser_live_media_manifest` | `browser_webrtc` | `artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json` | `npm run browser-webrtc:live-proof` |
| `sip_verto_live_manifest` | `sip_verto` | `artifacts/verto-sip-live-proof/manifest.json` | `npm run pipecat:verto:live-proof` |
| `signalwire_readiness` | `signalwire_pstn` | `artifacts/signalwire-freeswitch-readiness/readiness.json` | `npm run signalwire:freeswitch:readiness -- --render` |

## Phase 2 reliability-lab plan

The next implementation slice should add one explicit lab entry point that starts or connects:

1. ACC application.
2. Selected target media mode: fixture, browser WebRTC, SIP/Verto, or SignalWire PSTN.
3. rtc-asr and Kokoro when live media requires them.
4. ConversationAgentEvals API/web through configured external URLs or pinned images.
5. ASSERT through the ConversationAgentEvals boundary or local viewer.

The status API and command now expose `targetModes` so an external runner can select the fixture, browser WebRTC, SIP/Verto, or SignalWire PSTN path without scraping prose. Each mode declares its required components, required and optional endpoint environment variables, start/connect command, fastest validation command, evidence command, readiness route, CAE handoff command, provenance requirements, and `nextAction` for the immediate unblock-or-validate step.
Each mode also reports `missingEndpointEnvVars` as a machine-readable list, so runners can present the exact environment setup gap without parsing human-facing blocker text.
For `signalwire_pstn`, the mode also reports `signalwireTrunkMode`, `requiredSignalwireEnvVars`, and `missingSignalwireEnvVars`. Registration trunks require SignalWire Space URL and SIP credentials in addition to DID, public FreeSWITCH SIP host, provider source ACL, and external SIP reachability proof inputs; `SIGNALWIRE_TRUNK_MODE=ip_auth` narrows the required SignalWire env list to the IP-auth gate inputs.

They also expose `runProfiles` so an orchestrator can choose the smallest suitable lab shape:

- `local_fixture`: ACC-only deterministic proof and CAE-compatible request generation.
- `connected_cae`: external ConversationAgentEvals URLs plus the fixture/reliability-lab target modes.
- `live_media_lab`: CAE-connected browser/SIP/PSTN media evidence after rtc-asr, TTS, and transport endpoints are configured.

The first local entry point is:

```bash
npm run docker:reliability-lab
```

It starts the ACC app, rtc-asr, Kokoro, Pipecat browser bridge, and local ASSERT viewer through the `reliability-lab` Compose profile. ConversationAgentEvals remains external; set `CAE_API_URL` and `CAE_WEB_URL` before using the handoff path.

For automation that needs only the selected entry point, run:

```bash
npm run reliability:entrypoint
```

Rules for Phase 2:

- Do not use git submodules.
- Do not copy ConversationAgentEvals, rtc-asr, or ASSERT source into ACC.
- Prefer pinned images or explicit service URLs.
- Keep CAE unavailability from breaking the normal ACC demo or operator console.
- Report `configured`, `reachable`, `ready`, `fixture`, `blocked`, and `not_required` separately.

## Phase 3 guided workflow plan

The `/reliability` route now provides the first guided surface for:

1. Component readiness.
2. Baseline/candidate selection.
3. Fixture, browser, or SIP/Verto execution mode.
4. ACC proof bundle collection.
5. CAE run/deep-link submission.
6. ASSERT-backed report links.
7. Baseline versus controlled-candidate comparison.

It must be an integration guide, not a second generic evaluator product.
