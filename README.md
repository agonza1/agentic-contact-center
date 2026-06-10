# Agentic Contact Center

Minimal ClueCon 2026 seed repo for a cancellation-rescue demo:

`SignalWire -> FreeSWITCH -> Pipecat Flows -> OpenClaw -> Slack human steer`

This repository does not yet contain the runnable app scaffold. Right now it captures the scenario, guardrails, and handoff boundaries so implementation can start from a clear contract instead of a vague idea.

## Scenario

- Demo name: `cluecon-2026-cancellation-rescue`
- Flow states: `call_started`, `greet`, `diagnose`, `policy_hold`, `operator_steer`, `steered_response`, `wrap`
- Default supervisor steer: `approve_offer`
- Fallback mode: `tool_timeout`

The scripted caller says:

1. `I want to cancel. This has failed twice this week and I am done.`
2. `A live customer call. We missed a sales call.`

The agent must pause at the risky offer boundary, request human steer, and avoid promising billing credits.

## Current repo state

This repo currently contains:

- a product-direction README
- an example config contract in [`config/poc.config.example.json`](./config/poc.config.example.json)
- a small implementation outline in [`docs/poc-outline.md`](./docs/poc-outline.md)

## Runnable scaffold

The first runnable scaffold now includes:

- a minimal Node/TypeScript project setup
- config loading from [`config/poc.config.example.json`](./config/poc.config.example.json)
- core POC domain types and runtime seam interfaces
- `GET /health` for demo metadata and runtime seam visibility

Run it locally with `npm install`, `npm test`, and `npm start`.

## Planned first scaffold

The initial implementation slice should add:

- a deterministic mocked cancellation-rescue flow engine
- a local HTTP harness for starting a call and posting turns
- a terminal demo runner for the scripted scenario
- a simple event trail and latency budget recorder
- focused tests around policy hold, operator steer, and fallback behavior

## Planned HTTP API

- `POST /api/demo/start`
  Starts a new mocked call session.
- `POST /api/calls/:callId/caller-turn`
  Adds a caller utterance.
- `POST /api/calls/:callId/operator-steer`
  Applies supervisor steer such as `approve_offer` or `escalate_to_human`.
- `POST /api/calls/:callId/fallback`
  Enables a forced fallback mode such as `tool_timeout`.
- `GET /api/calls/:callId`
  Returns call state, transcript, event trail, budgets, and session metadata.
- `GET /health`
  Returns basic health and available demo configuration.

## Config contract

The canonical example config lives at [`config/poc.config.example.json`](./config/poc.config.example.json).

Key defaults:

- mode: `mocked_telephony`
- provider: `signalwire`
- provider_call_id: `mock-sw-call-001`
- policy profile: `retention_safe_mode`
- tool scope: `deny_by_default`
- slack channel: `demo-operator-console`
- latency budgets:
  - `asr_partial`: `500ms`
  - `policy_gate`: `1500ms`
  - `operator_notification`: `2000ms`
  - `tts_first_audio`: `1200ms`

## Stage-demo behavior

- Deny by default for risky tools and commercial promises
- Pause on policy boundary before any retention offer
- Notify a Slack-style supervisor console with recommended actions
- Record an OpenClaw-style per-call session metadata envelope and event trail
- Emit latency records for each critical stage
- Fail closed on `tool_timeout` and escalate instead of inventing missing facts

## Next adapters

The current seams are intended to support live adapters later:

- SignalWire webhook ingress
- FreeSWITCH media/control bridge
- Pipecat transport/session orchestration
- OpenClaw operator actions and call-state visibility
- Slack or web console human steering
