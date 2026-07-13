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

## Pipecat 1.4 media-pipeline alignment

Issue #222 is the migration lane from the current custom browser WebRTC bridge toward the Pipecat 1.4 media shape:

```text
transport.input -> rtc-asr STT -> ACC caller-turn adapter -> Kokoro TTS -> transport.output
```

`requirements-pipecat-voice.txt` requests `pipecat-ai[webrtc]==1.4.0` so local installs include the WebRTC extras needed for `SmallWebRTCTransport`. The current bridge remains `scripts/pipecat-browser-webrtc-bridge.py`; the target is a Pipecat `SmallWebRTCTransport` offer route backed by a real `Pipeline`, while preserving the existing ACC `POST /api/browser-webrtc/session` contract. SIP should not use SmallWebRTCTransport; it should enter through the FreeSWITCH/SIP RTP adapter and share the same rtc-asr, ACC adapter, and Kokoro processors behind that transport.

Flows decision for the current MVP: keep cancellation-rescue conversation policy in ACC TypeScript for now. Policy hold, operator steer, proof artifacts, and queue state already live in ACC, so `FlowManager` is not required before the shared media Pipeline is live. Revisit Pipecat Flows after the browser and SIP transports share Pipeline processors. The older `scripts/pipecat-local-voice-bridge.py` path is legacy proof-only and should not be used as the normal browser voice path.

## Browser WebRTC voice readiness

Issue #213 moves the intended non-SIP browser voice path to realtime WebRTC into Pipecat:

```text
browser mic -> WebRTC -> Pipecat bridge -> rtc-asr Local STT v1 -> ACC call API -> Kokoro TTS -> WebRTC/browser playback
```

This repository now exposes the contract/readiness surface for that path:

```bash
curl -fsS http://127.0.0.1:8026/api/browser-webrtc/readiness
npm run browser-webrtc:check -- --url http://127.0.0.1:8026/health
npm run browser-webrtc:live-proof -- --write-template artifacts/browser-webrtc-live-proof/proof.template.json
npm run browser-webrtc:live-proof -- --evidence artifacts/browser-webrtc-live-proof/proof.json --require-review-ready
```

The payload reports `status=contract_ready_pending_live_media_evidence` when the ACC signaling contract is ready but a local browser media proof has not been attached. Browser SDP offers are accepted at `POST /api/browser-webrtc/session` and proxied to `BROWSER_WEBRTC_BRIDGE_URL` (default `http://127.0.0.1:8766`); failures are reported as Pipecat WebRTC bridge blockers instead of falling back to webm chunks. It also reports `normalOperation.ffmpegRequired=false`, `normalOperation.mediaRecorderRequired=false`, and `liveMedia.verified=false` so reviewers can separate contract readiness from the remaining local proof that browser mic audio reaches rtc-asr and Kokoro audio plays back through WebRTC. Use `--write-template` to generate the proof JSON event skeleton before capturing the real browser turn; the template includes the current git head and the review gate requires matching evidence so QA proof is tied to the PR commit under review.

Normal browser WebRTC sidecar setup:

```bash
cd ../rtc-asr
make mlx-venv
env PYTHONPATH=. \
  ASR_BACKEND=parakeet-mlx \
  ASR_DEVICE=apple-silicon \
  ASR_PRELOAD_MODEL=true \
  ASR_PARAKEET_MODEL=mlx-community/parakeet-tdt_ctc-110m \
  ASR_PARAKEET_DTYPE=auto \
  ASR_VAD_FILTER=false \
  .venv-mlx/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8080

cd ../agentic-contact-center
export RTC_ASR_BASE_URL=http://127.0.0.1:8080
export RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream
export RTC_ASR_MODEL=mlx-community/parakeet-tdt_ctc-110m
export KOKORO_BASE_URL=http://127.0.0.1:8880
export BROWSER_WEBRTC_BRIDGE_URL=http://127.0.0.1:8766
npm run pipecat:webrtc:install
npm start
npm run pipecat:webrtc:check
npm run pipecat:webrtc
```

`npm run pipecat:webrtc` starts `scripts/pipecat-browser-webrtc-bridge.py` on `http://127.0.0.1:8766`. Its offer endpoint is `POST /api/webrtc/offer`; ACC proxies browser SDP offers to it from `POST /api/browser-webrtc/session`. The bridge terminates browser WebRTC with `aiortc`, converts audio to PCM with PyAV/audioop, wraps the turn in Pipecat frame types, streams PCM to rtc-asr Local STT v1, posts the final transcript to `/api/calls/:callId/caller-turn`, requests Kokoro WAV audio, and streams PCM back as a WebRTC remote audio track. This normal path has no `ffmpeg` dependency.

## Unified Pipecat media-engine readiness

Issue #214 tracks the target shared media engine for browser WebRTC, local SIP/FreeSWITCH, and future SignalWire SIP trunk audio. The current reviewable contract is exposed at:

```bash
curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness
```

The payload is intentionally not a fake green light. It marks the browser Pipecat voice bridge as implemented, keeps the local SIP/FreeSWITCH proof bundle behavior intact, and reports the remaining blocker: FreeSWITCH RTP is not yet streamed bidirectionally through Pipecat frames for realtime SIP caller playback. The FreeSWITCH bridge can optionally listen on `ACC_FREESWITCH_RTP_LISTEN_PORT`/`--rtp-listen-port` and collect inbound PCMU RTP packets into Pipecat-compatible `InputAudioRawFrameBatch` evidence, but rtc-asr streaming and Kokoro RTP playback still need the next wiring slice. SignalWire is documented as a future SIP trunk -> FreeSWITCH/Pipecat route; historical/past-call import remains a separate importer task.

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
  -d '{}'
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

Generate a ConversationAgentEvals-ready proof bundle with media artifacts:

```bash
npm run proof:pipecat -- --out artifacts/agentic-call-center-demo/source-proof.json --latest-out artifacts/demo-proof-latest.json
npm run proof:bundle -- --proof artifacts/agentic-call-center-demo/source-proof.json --out-dir artifacts/agentic-call-center-demo
```

The bundle writes `proof-bundle-manifest.json`, `conversation-agent-evals-assert-request.json`, transcript/action/final-state files, a seeded local WAV caller capture, SVG operator-console screenshots, an animated GIF recording, and Local STT v1 framing evidence for the `rtc-asr` boundary. It remains local and mocked: live telephony and provider credentials are not used unless a later live-capture path explicitly provides them.

See `docs/demo-proof-runbook.md` for inspection checklists.

## Common filters and pagination

Common list/queue filters include `callId`, `providerCallId`, `flowState`, `pipecatActiveTool`, `pendingOperatorSteer`, `fallbackArmed`, `attentionRequired`, `attentionSource`, `attentionReason`, `transcriptText`, `scriptCompleted`, `minScriptProgressPct`, `maxScriptProgressPct`, `minAttentionAgeMs`, `maxAttentionAgeMs`, `latencyStage`, `latencyOverBudget`, `fallbackMode`, `fallbackReason`, and `fallbackSource`.

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
- `GET /api/pipecat-media-engine/readiness`: expose the Issue #214 shared browser WebRTC, local SIP/FreeSWITCH, and SignalWire SIP trunk Pipecat media-engine contract, including the current realtime SIP RTP blocker.
- `GET /api/browser-webrtc/readiness`: expose the Issue #213 browser WebRTC voice contract, dependency readiness, and bridge endpoint.
- `POST /api/browser-webrtc/session`: validate browser SDP offers, allocate or preserve an ACC call ID, and proxy offer/answer signaling to the local Pipecat WebRTC bridge.
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
- `npm run pipecat:check`: verify the local `pipecat-ai` runtime package boundary without live telephony.
- `npm run pipecat:webrtc:install`: install Pipecat voice bridge dependencies into `.pipecat-runtime`.
- `npm run browser-webrtc:check`: verify `/health` exposes the normal browser WebRTC path with ACC, Pipecat bridge, rtc-asr, and Kokoro readiness and no normal-path `ffmpeg` requirement.
- `npm run pipecat:webrtc:readiness`: alias for the browser WebRTC readiness smoke check.
- `npm run pipecat:webrtc:check`: verify rtc-asr, Kokoro, ACC, and the browser WebRTC bridge dependencies for the normal non-ffmpeg path.
- `npm run pipecat:webrtc`: run the normal browser WebRTC Pipecat bridge on `http://127.0.0.1:8766`.
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
- `npm run docker:voice`: run ACC with optional rtc-asr and Kokoro sidecars.
- `npm run docker:browser-webrtc`: run ACC, rtc-asr, Kokoro, and the Pipecat browser WebRTC bridge.
- `npm run docker:sip`: run ACC, FreeSWITCH, the FreeSWITCH ESL bridge, rtc-asr, and Kokoro for local SIP lab work.
- `npm run docker:assert`: export ASSERT artifacts and start the upstream ASSERT viewer.
- `npm run docker:full`: run all optional local contact-center services.

## Docker Compose profiles

The default Compose path only starts `app` unless another service is requested. Optional profiles describe the full local contact-center lab stack without making every dependency mandatory for a quick demo:

- `voice`: `rtc-asr` and `kokoro` sidecars. `rtc-asr` listens on `8080`, Kokoro listens on `8880`, and ACC is preconfigured with Docker-network URLs for both.
- `browser-webrtc`: adds `browser-webrtc-bridge` on `8766`, using the `voice-runtime` Dockerfile target with Pipecat WebRTC Python dependencies installed into `.pipecat-runtime`.
- `sip`: adds FreeSWITCH plus `freeswitch-bridge`, writes SIP/media proof artifacts under `artifacts/freeswitch-live`, and points the bridge at Docker-network rtc-asr/Kokoro URLs.
- `eval`: runs `assert-viewer`, exporting ACC ASSERT artifacts before starting the upstream ASSERT viewer on `5174`.
- `full`: enables every optional service above for an end-to-end local lab stack.

The `rtc-asr` service defaults to `RTC_ASR_IMAGE=rtc-asr:local` because the ASR server is owned by the sibling `rtc-asr` project. Build that image from the `rtc-asr` checkout or override `RTC_ASR_IMAGE` with a compatible image before using `voice`, `browser-webrtc`, `sip`, or `full`. Kokoro defaults to `KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:latest`; override it if the lab uses a different Kokoro FastAPI image.

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
