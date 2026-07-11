# Runtime reference

Use this reference for commands and route details that are useful during development or QA but too detailed for the README.

## Configuration

The Node server reads `config/poc.config.example.json` from the repo root by default. Set `POC_CONFIG_PATH` to point at another JSON config file. It must include:

- `demoName` and `mode`
- `provider.name` and `provider.callId`
- `policy.profile`, `policy.toolScope`, `policy.defaultSupervisorSteer`, and `policy.fallbackMode`
- `operator.channel`
- `latencyBudgetsMs`

Environment variables:

- `PORT`: optional HTTP port for `npm start`; defaults to `8026`.
- `POC_CONFIG_PATH`: optional path to a JSON config file; defaults to `config/poc.config.example.json`.
- `LOCAL_UID` / `LOCAL_GID`: optional Docker proof runner ownership override for Linux bind-mounted artifacts.
- `RTC_ASR_BASE_URL`: rtc-asr HTTP base URL for health checks; defaults to `http://127.0.0.1:8080`.
- `RTC_ASR_WS_URL`: rtc-asr Local STT v1 websocket URL; defaults to `ws://127.0.0.1:8080/v1/stt/stream`.
- `RTC_ASR_MODEL`: evidence label for the rtc-asr model selected from benchmark artifacts; defaults to `mlx-community/parakeet-tdt_ctc-110m`.
- `KOKORO_BASE_URL`: Kokoro HTTP base URL; defaults to `http://127.0.0.1:8880`.
- `KOKORO_HEALTH_PATH`: Kokoro health path; defaults to `/health`.
- `KOKORO_SPEECH_PATH`: Kokoro speech endpoint; defaults to `/v1/audio/speech`.
- `KOKORO_VOICE`: Kokoro voice id; defaults to `af_heart`.

There is no `.env` file in the current Node app.

## Optional Pipecat package check

```bash
python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt
npm run pipecat:check
```

This verifies the local `pipecat-ai` package boundary only. It does not open microphones, start live telephony, or use provider credentials.

## Local voice bridge sidecars

The browser voice bridge requires rtc-asr and Kokoro to be running before live voice turns. rtc-asr owns ASR model loading and Kokoro owns speech synthesis. The default rtc-asr evidence label is `mlx-community/parakeet-tdt_ctc-110m`, chosen from the checked-in rtc-asr MLX service benchmark lane as the fast small English contact-center option (`docs/benchmark-results/parakeet-mlx-110m-service-2026-06-21.json`). Override only when rtc-asr is configured with a different model:

```bash
export RTC_ASR_BASE_URL=http://127.0.0.1:8080
export RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream
export RTC_ASR_MODEL=mlx-community/parakeet-tdt_ctc-110m
export KOKORO_BASE_URL=http://127.0.0.1:8880
export KOKORO_VOICE=af_heart
npm run pipecat:voice:check
npm run pipecat:voice
```

The bridge ready payload and each successful `turn.evidence` report `stt.engine=rtc-asr` and `tts.engine=kokoro`, plus sidecar health or elapsed timing.

## Unified Pipecat media-engine readiness

Issue #214 tracks the target shared media engine for browser WebRTC, local SIP/FreeSWITCH, and future SignalWire SIP trunk audio. The current reviewable contract is exposed at:

```bash
curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness
```

The payload is intentionally not a fake green light. It marks the browser Pipecat voice bridge as implemented, keeps the local SIP/FreeSWITCH proof bundle behavior intact, and reports the remaining blocker: FreeSWITCH RTP is not yet streamed bidirectionally through Pipecat frames for realtime SIP caller playback. SignalWire is documented as a future SIP trunk -> FreeSWITCH/Pipecat route; historical/past-call import remains a separate importer task.

## Demo flow

Seeded caller turns for the cancellation-rescue script:

1. `I want to cancel my policy today.`
2. `The renewal increase is too high.`
3. `Okay, what safe options can you review for me?`
4. `Thanks, please note that follow-up and close the call.`

The flow enters `policy_hold` before unsafe retention offers, requests operator steer, and resumes only after a safe action such as `approve_offer`. The fallback path accepts `tool_timeout` and `runtime_failure` modes to arm a fail-closed human handoff.

## Minimal manual exercise

```bash
curl -s -X POST http://localhost:8026/api/demo/start \
  -H 'content-type: application/json' \
  -d '{"openclawSessionLabel":"manual-demo"}'
```

Use the returned `session.callId` in follow-up calls:

```bash
curl -s -X POST http://localhost:8026/api/calls/<callId>/caller-turn \
  -H 'content-type: application/json' \
  -d '{"text":"I want to cancel my policy today."}'

curl -s http://localhost:8026/api/calls/<callId>
```

## Local SignalWire bridge exercise

```bash
curl -s -X POST http://localhost:8026/api/signalwire/events \
  -H 'content-type: application/json' \
  -d '{"eventType":"call.started","signalWireCallId":"sw-demo-1"}'

curl -s -X POST http://localhost:8026/api/signalwire/events \
  -H 'content-type: application/json' \
  -d '{"eventType":"media.transcript","signalWireCallId":"sw-demo-1","text":"I want to cancel my policy today."}'
```

The local bridge treats SignalWire as the telephony entrypoint while keeping credentials mocked and persists the SignalWire call id as `providerCallId` for queue lookup/filtering. `call.error` routes to the existing `tool_timeout` fallback/human handoff path, and `call.ended` safely closes the demo call. Demo recording and consent remain explicit operator responsibilities before connecting real callers.

## Proof commands

Generate reviewable JSON evidence:

```bash
npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

Gate the proof on the local Pipecat package boundary:

```bash
npm run proof:pipecat -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json
```

Generate realtime shim issue proof evidence:

```bash
npm run proof:realtime-shim -- --out artifacts/realtime-shim-proof.json
```

Generate speech enhancement spike proof evidence:

```bash
npm run proof:speech-enhancement
```

Generate a ConversationAgentEvals-ready proof bundle with media artifacts:

```bash
npm run proof:pipecat -- --out artifacts/agentic-call-center-demo/source-proof.json --latest-out artifacts/demo-proof-latest.json
npm run proof:bundle -- --proof artifacts/agentic-call-center-demo/source-proof.json --out-dir artifacts/agentic-call-center-demo
```

The bundle writes `proof-bundle-manifest.json`, `conversation-agent-evals-assert-request.json`, transcript/action/final-state files, a seeded local WAV caller capture, SVG operator-console screenshots, an animated GIF recording, and Local STT v1 framing evidence for the `rtc-asr` boundary. It remains local and mocked: live telephony and provider credentials are not used unless a later live-capture path explicitly provides them.

See `docs/demo-proof-runbook.md` for inspection checklists.

## Common filters and pagination

Common list/queue filters include `callId`, `providerCallId`, `flowState`, `pipecatActiveTool`, `pendingOperatorSteer`, `fallbackArmed`, `attentionRequired`, `attentionSource`, `attentionReason`, `openclawSessionId`, `openclawSessionLabel`, `openclawSessionRef`, `transcriptText`, `scriptCompleted`, `minScriptProgressPct`, `maxScriptProgressPct`, `minAttentionAgeMs`, `maxAttentionAgeMs`, `latencyStage`, `latencyOverBudget`, `fallbackMode`, `fallbackReason`, and `fallbackSource`.

Call, transcript, event, and latency routes support pagination with `offset`, `limit`, and `order=asc|desc`. Event trails also support `detailKey` and `detailText` filters for scoped QA proof lookups. Their max page size is `100`.

## API overview

- `GET /health`: service/config/runtime readiness.
- `POST /api/demo/start`: create a mocked call session.
- `POST /api/demo/run-end-to-end`: run the complete seeded call flow and return the final call snapshot, console payload, steps, and proof bundle.
- `POST /api/signalwire/events`: exercise the local SignalWire bridge contract for `call.started`, `media.transcript`, `call.ended`, and fail-closed `call.error` events without production credentials.
- `POST /api/calls/:callId/caller-turn`: append a caller transcript turn and advance the flow.
- `POST /api/calls/:callId/operator-steer`: apply operator commands or direct actions, including pause/resume, approval, takeover, escalation, and safe call closeout.
- `POST /api/calls/:callId/operator-note`: record operator notes and optional dispositions into the transcript and proof event trail.
- `POST /api/calls/:callId/fallback`: trigger demo fallback with `tool_timeout` or `runtime_failure`.
- `GET /api/calls`: list active calls with optional queue/operator filters.
- `GET /api/queue`: return queue summary metadata without full call payloads.
- `GET /api/operator/actions`: expose the Slack-ready operator action catalog with command examples, reason/pending-call requirements, HTTP body templates, and outcome hints for console buttons.
- `GET /api/realtime-shim/proof`: expose deterministic Gateway relay and Local STT v1 evidence for the mocked realtime shim path.
- `GET /api/realtime-shim/readiness`: summarize adapter shape, browser relay compatibility, reviewer packet, mocked pieces, and limitations from proof evidence.
- `GET /api/pipecat-media-engine/readiness`: expose the Issue #214 shared browser WebRTC, local SIP/FreeSWITCH, and SignalWire SIP trunk Pipecat media-engine contract, including the current realtime SIP RTP blocker.
- `GET /api/realtime-shim/speech-enhancement-spike`: summarize latency-configurable speech enhancement placement, candidate latency settings, replay metric shape, and feature-flag recommendation for `rtc-asr`.
- `POST /api/realtime-shim/rpc`: exercise the `talk.session.*` Gateway relay RPC boundary with persistent local shim session state.
- `GET /assert/full`: serve the local navigation wrapper around the upstream ASSERT viewer on `http://127.0.0.1:5174`.
- `GET /assert`: serve the ACC local artifact viewer.
- `GET /assert/spec`: serve the editable local ASSERT evaluation spec UI.
- `GET /api/assert/spec`: return the active in-memory eval spec, reusable blocks, and generated YAML.
- `POST /api/assert/spec/preview`: validate a draft eval spec and return generated YAML without saving.
- `POST /api/assert/spec`: save the active in-memory eval spec for the running process.
- `POST /api/assert/spec/reset`: reset the active eval spec to the default.
- `GET /api/calls/:callId`: fetch the current call snapshot.
- `GET /api/calls/:callId/transcript`: fetch filterable transcript pages.
- `GET /api/calls/:callId/events`: fetch filterable event evidence.
- `GET /api/calls/:callId/latency`: fetch filterable latency evidence.
- `GET /api/calls/:callId/artifacts`: fetch the artifact manifest for the call.
- `GET /api/calls/:callId/proof`: export a per-call QA proof bundle.

## Scripts

- `npm run build`: compile TypeScript to `dist/`.
- `npm test`: build and run Node tests from `dist/test/*.test.js`.
- `npm start`: run the compiled server from `dist/src/index.js`.
- `npm run proof`: build and run `scripts/demo-proof.mjs`.
- `npm run proof:realtime-shim`: build and write the realtime shim proof artifact.
- `npm run proof:speech-enhancement`: build and write the speech enhancement spike artifact.
- `npm run pipecat:check`: verify the local `pipecat-ai` runtime package boundary without live telephony.
- `npm run pipecat:voice:install`: install Pipecat voice bridge dependencies into `.pipecat-runtime`.
- `npm run pipecat:voice:check`: verify rtc-asr and Kokoro health before opening the browser microphone path.
- `npm run pipecat:voice`: run the local browser voice bridge on `ws://127.0.0.1:8765`.
- `npm run assert:export`: generate official ASSERT local-viewer artifacts under `artifacts/results/agentic-contact-center-voice-demo/...`.
- `npm run assert:viewer:install`: clone and install the upstream ASSERT viewer into `.assert-viewer/`.
- `npm run assert:viewer`: run the upstream ASSERT viewer against this repo's `artifacts/results` at `http://127.0.0.1:5174`.
- `npm run assert:full`: export artifacts, then start the upstream ASSERT viewer.
- `npm run proof:pipecat`: run `pipecat:check` before the proof harness.
- `npm run proof:bundle`: convert a proof JSON file into a ConversationAgentEvals-ready evidence bundle with media artifacts.
- `npm run health:smoke`: poll `http://127.0.0.1:8026/health`.
- `npm run docker:app`: build and run the Docker app service in the foreground.
- `npm run docker:smoke`: run a bounded Docker health probe and clean up.
- `npm run docker:proof`: run the proof harness in Compose and write artifacts.

## Local SIP live capture

This repo has a local SIP live-capture path. It does not require or store production SignalWire credentials.

Quick local harness self-test, marked `generated_media` and not review-ready:

```bash
npm run build
PORT=8026 npm start
npm run sip:self-test -- --acc-url http://127.0.0.1:8026
npm run proof:live-sip-bundle -- --live-manifest artifacts/local-sip-selftest/local-sip-live-proof-manifest.json --out-dir artifacts/local-sip-selftest-bundle
```

FreeSWITCH local SIP target:

- SIP account: `1000` / `local-sip-pass` at `127.0.0.1:5060` UDP
- Dial: `8600`
- ESL bridge: `npm run freeswitch:bridge -- --acc-url http://127.0.0.1:8026`
- Docker profile: `npm run docker:freeswitch` when Docker is available
- FreeSWITCH-only compose start: `npm run docker:freeswitch:only` when ACC is already running locally
- Runbook: `docs/freeswitch-local-sip-runbook.md`

Review release requires a real local SIP softphone call with `live_capture`, not the generated self-test. If `RTC_ASR_WS_URL` is not set, the bundle emits an explicit `rtc_asr_blocked` artifact and blocker instead of a fake transcript.

The operator/demo UI for this path is `/operator/console`. Select the live SIP call to see the visible run/session id, SIP/FreeSWITCH/SignalWire runtime labels, audio WAV and SIP log paths, live transcript or `rtc-asr` blocker state, proof/eval links, caveats, and operator controls for fallback, takeover, transfer, or end-call handoff.
