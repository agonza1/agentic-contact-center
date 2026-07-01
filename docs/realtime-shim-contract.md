# Realtime Shim Adapter Contract

Workboard card: `1c94e2b0-6c84-4af4-9cb8-66a549266f25`. GitHub issue: `agonza1/agentic-contact-center#84`.

This note defines the adapter contract for preserving the current OpenClaw Web Talk UI while routing a voice turn through a local `rtc-asr -> local LLM -> Kokoro TTS` pipeline. It is a contract note only: no production OpenClaw code, full shim implementation, or `rtc-asr#203` work is included here.

## Inspected OpenClaw Surface

Read-only inspection used `agonza1/openclaw` at commit `7a750100`.

- The browser entrypoint is `ui/src/ui/app.ts`: `toggleRealtimeTalk()` builds `RealtimeTalkLaunchOptions`, calls `new RealtimeTalkSession(...)`, and exposes only `onStatus` plus `onTranscript` callbacks to the chat UI.
- The composer control is `ui/src/ui/views/chat.ts`: the Talk button starts/stops the same session and shows `Connecting Talk...`, `Talk live`, or `Asking OpenClaw...` based on session status.
- `ui/src/ui/chat/realtime-talk.ts` first calls `talk.client.create`; for `gateway-relay` it falls back to `talk.session.create({ mode: "realtime", transport: "gateway-relay", brain: "agent-consult" })`.
- The local shim should integrate as a Gateway-owned `gateway-relay` provider, not as a browser WebRTC replacement. The browser then keeps using `talk.session.appendAudio`, `talk.session.cancelOutput`, `talk.session.submitToolResult`, and `talk.session.close`; QA harnesses may also call `talk.session.getEvidence` for a read-only timeline snapshot.
- `GatewayRelayRealtimeTalkTransport` records microphone audio with `getUserMedia`, converts float samples to little-endian PCM16, sends `audioBase64` chunks through `talk.session.appendAudio`, plays returned PCM16 `audioBase64`, and detects barge-in locally while output is playing.

## Session And Transport

The adapter should return a normal OpenClaw `RealtimeVoiceBrowserGatewayRelaySession` shape from `talk.session.create`:

```json
{
  "provider": "local-realtime-shim",
  "transport": "gateway-relay",
  "relaySessionId": "local-rt-...",
  "sessionId": "local-rt-...",
  "mode": "realtime",
  "brain": "agent-consult",
  "audio": {
    "inputEncoding": "pcm16",
    "inputSampleRateHz": 24000,
    "outputEncoding": "pcm16",
    "outputSampleRateHz": 24000
  },
  "model": "local-llm",
  "voice": "kokoro",
  "expiresAt": 0
}
```

OpenClaw Web sends microphone chunks as Gateway RPC payloads, not directly over the sidecar websocket:

```json
{ "sessionId": "local-rt-...", "audioBase64": "...", "timestamp": 1234 }
```

The shim decodes these chunks to PCM16, resamples to the Local STT hot path when needed, and talks to `rtc-asr` over Local STT v1 at `ws://.../v1/stt/stream`. The sidecar path must use binary PCM16 websocket messages for audio; base64 is only the OpenClaw Gateway relay boundary.

### Gateway Relay RPC Contract

The first shim proof should keep the browser-facing RPCs identical to the current Gateway relay provider and implement these handlers behind the Gateway boundary:

| RPC | Required request fields | Required behavior |
| --- | --- | --- |
| `talk.session.create` | `mode: "realtime"`, `transport: "gateway-relay"`, optional `brain` | Allocate a relay session, initialize empty input/output state, return the session envelope above, and emit a single `ready` diagnostic. |
| `talk.session.appendAudio` | `sessionId`, `audioBase64`, optional `timestamp` | Decode PCM16, start Local STT v1 lazily on the first non-empty chunk, stream binary frames, and keep the RPC bounded even if STT transcript output arrives later. |
| `talk.session.getEvidence` | `sessionId` | Return the current diagnostics, relay events, timeline, latency marks, and named mocked pieces without mutating session state. |
| `talk.session.cancelOutput` | `sessionId`, optional `reason` (`barge-in`, `cancelled`, or `error`) | Validate the target session, abort active LLM/TTS work, clear pending audio, emit relay `clear`, and keep input capture alive for barge-in audio. |
| `talk.session.cancelInput` | `sessionId` | Validate the target session, discard uncommitted user audio, send Local STT `cancel`, and return input-cancel evidence without closing the relay session. |
| `talk.session.submitToolResult` | `sessionId`, `toolCallId`, `result` | Validate the target session and tool call id, then accept and record the tool result for parity with the existing UI path; the first local proof may return `not_applicable` when no local tool call is pending. |
| `talk.session.close` | `sessionId`, optional `reason` (`client`, `complete`, or `error`) | Validate the target session, idempotently close STT, LLM, and TTS resources, then emit one terminal relay `close`. |

The shim must correlate every asynchronous event with both `relaySessionId` and `sessionId` when both are known. Unknown or already-closed sessions return a bounded RPC error instead of creating an implicit session.

### Sidecar State Machine

For the local proof, one relay session owns at most one active STT stream and one active assistant output at a time:

```text
idle -> listening -> finalizing -> responding -> speaking -> listening
  |        |            |             |            |
  |        +-- cancel --+             +-- cancelOutput --+
  +------------------------------ close/error -----------> closed
```

- `idle` begins after `talk.session.create` and before the first audio chunk.
- `listening` begins when the shim sends Local STT v1 `start` and first binary PCM16 frames.
- `finalizing` begins after `finalize`; only a final transcript may advance to `responding`.
- `responding` owns the local LLM request and queues text for Kokoro.
- `speaking` owns Kokoro PCM chunks and browser relay `audio` events.
- `closed` is terminal and suppresses all stale transcript, text, and audio events.

## Audio And Event Mapping

| OpenClaw / Realtime-style intent | Shim behavior | Local STT v1 behavior |
| --- | --- | --- |
| `talk.session.create` / Realtime session create | Allocate one relay session, start one current STT utterance when first audio arrives, emit `ready`. | Send `{ "type": "start", "version": "local-stt.v1", "audio": { "sample_rate": 16000, "channels": 1, "format": "pcm_s16le", "frame_ms": 20, "bytes_per_frame": 640 }, "interim_results": true }`. |
| `talk.session.appendAudio` / `input_audio_buffer.append` | Decode `audioBase64`, normalize to mono PCM16, emit `input.audio.delta` diagnostics if useful. | Send binary PCM16 frames after `start`; never base64-wrap this hop. |
| Endpointer or manual proof commit / `input_audio_buffer.commit` | Finalize the active user utterance and wait for final transcript before LLM dispatch. | Send `{ "type": "finalize" }`. |
| `talk.session.cancelTurn` or `input_audio_buffer.clear` | Drop uncommitted user audio, clear the active capture, and do not call the LLM. | Send `{ "type": "cancel" }`; expect warning `stream_canceled` or equivalent non-final outcome. |
| Local STT partial transcript | Emit `talk.event` `transcript.delta` and optionally relay `transcript { role: "user", final: false }`. | Consume `transcript` with `is_final: false`. |
| Local STT final transcript | Emit `transcript.done`, relay `transcript { role: "user", final: true }`, then call local LLM. | Consume `transcript` with `is_final: true` and `speech_final: true`. |
| Local LLM text | Emit `output.text.delta`/`output.text.done` and queue Kokoro synthesis. | No STT action. |
| Kokoro PCM output | Relay `audio { audioBase64 }`; emit `output.audio.started`, `output.audio.delta`, then `output.audio.done`. | No STT action. |
| `talk.session.close` | Close TTS, LLM, and STT resources; emit terminal close once. | Send `{ "type": "close" }` and accept `closed` or websocket close as terminal. |

## Interruption And Cancel

- Browser barge-in detection already calls `talk.session.cancelOutput({ reason: "barge-in" })` after local RMS/peak speech detection while output audio is playing.
- `cancelOutput` must immediately stop Kokoro output, mark queued audio chunks stale, emit a `clear` relay event so the browser stops playback, and emit `turn.cancelled` when the assistant response is abandoned.
- `cancelOutput` is not the same as Local STT `cancel`: only send Local STT `cancel` when the active user input buffer is being discarded.
- If barge-in audio is also part of the next user turn, keep or start a fresh Local STT `start` and continue feeding subsequent `appendAudio` chunks after output is cancelled.
- Tool/agent consult cancellation should abort any in-flight local LLM call before stale text or audio can be emitted.

## Output Audio

The smallest proof should advertise `pcm16` at `24000` Hz on the OpenClaw boundary because OpenClaw's provider types define browser PCM16 realtime audio at 24 kHz. Local STT remains `16000` Hz mono PCM16. The shim owns all resampling between browser input, Local STT, Kokoro output, and browser playback.

Each output chunk uses the Gateway relay event shape consumed by `GatewayRelayRealtimeTalkTransport`:

```json
{ "relaySessionId": "local-rt-...", "type": "audio", "audioBase64": "..." }
```

Send `mark` only if the shim needs playback acknowledgement later; the current browser transport schedules the acknowledgement locally but does not send an explicit ack RPC.

## Errors And Close

- Local STT `warning` maps to `talk.event` diagnostics and should not fail the session by default.
- Local STT `error` with `retryable: true` maps to relay `error` plus `session.error` while allowing the UI to show a recoverable error. Fatal errors close the relay with `{ "type": "close", "reason": "error" }`.
- Gateway RPC validation errors should remain bounded request failures, not silent hangs.
- `close` is idempotent. A second browser stop, sidecar close, LLM abort, or Kokoro shutdown should not emit duplicate terminal events.
- Terminal close emits `session.closed` for normal shutdown or `session.error` followed by relay `close { reason: "error" }` for fail-closed fallback.

## Smallest Proof Path

The first proof can be a local Gateway relay shim harness with mocked LLM text and mocked or file-backed Kokoro PCM:

1. `talk.session.create` returns a `gateway-relay` session declaring PCM16 input/output.
2. `talk.session.appendAudio` decodes base64 PCM16, sends Local STT v1 `start`, streams at least one binary PCM16 frame, and observes `ready` plus transcript output.
3. A deterministic endpointer or explicit test hook sends Local STT v1 `finalize`, converts the final transcript into one local assistant text response, and emits `transcript.done` plus `output.text.done`.
4. The shim emits one `audio` relay event and matching `output.audio.delta`/`output.audio.done` diagnostics.
5. `talk.session.cancelOutput` during playback emits `clear`, aborts the active assistant response, and prevents stale Kokoro audio from playing.
6. `talk.session.cancelInput` discards uncommitted user audio, emits `input.cancelled`, sends Local STT v1 `cancel`, and leaves the relay session reusable for the next utterance.
7. Local STT v1 `error` and `close` paths produce bounded relay `error`/`close` events instead of a hanging Talk status.

This confirms `rtc-asr#203` is the right upstream support card: it should add a generic Local STT v1 contract check for `start`, binary PCM16 audio, partial/final `transcript`, `finalize`, `cancel`, `error`, and `close` without OpenClaw-specific code.

## Ownership

- `agentic-contact-center`: keeps this adapter contract, mocked local response policy, and demo fallback behavior.
- `rtc-asr`: owns Local STT v1 lifecycle checks and sidecar benchmark artifacts.
- Future OpenClaw integration: registers the local realtime provider and wires the Gateway relay shim while preserving the existing Talk button, options, transcript display, and playback path.
