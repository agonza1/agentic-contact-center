# Realtime Shim Adapter Contract

This note defines the first local voice-pipeline contract for preserving an OpenAI Realtime-style web voice UI while routing audio through local services. It is intentionally adapter-level: `agentic-contact-center` owns the demo contract, while production OpenClaw UI changes and the full shim implementation stay out of scope.

## Session Shape

The browser keeps the familiar Realtime session model:

1. Create a short-lived voice session for one UI conversation.
2. Open a websocket to the shim.
3. Stream microphone PCM16 audio into an input buffer.
4. Commit the buffer when the user turn should be finalized.
5. Receive transcript, assistant text, and output-audio events.
6. Cancel or interrupt the active response when the user speaks over it.
7. Close the websocket when voice mode ends.

The shim should expose stable session metadata before websocket upgrade: `session_id`, `expires_at`, supported input audio format, supported output audio format, and whether server-side VAD is enabled. The smallest proof path can use manual commit only; VAD can be documented as unsupported until the pipeline has a measured policy for endpointing.

## Event Mapping

| Realtime-style client intent | Shim action | Local STT v1 action |
| --- | --- | --- |
| `input_audio_buffer.append` | Decode or pass through PCM16 and write binary audio frames. | Send binary PCM16 websocket frames after `start`. |
| `input_audio_buffer.commit` | End the current user utterance and request a final transcript before LLM dispatch. | Send `{ "type": "finalize" }`. |
| `input_audio_buffer.clear` | Drop buffered, uncommitted user audio. | Send `{ "type": "cancel" }` if an utterance is active. |
| `response.cancel` or barge-in | Stop TTS playback and abandon the active assistant response. | Do not finalize any new user audio until a new `start` has been acknowledged. |
| Session close | Drain any in-flight terminal event and close cleanly. | Send `{ "type": "close" }` and expect `closed`. |

The Local STT sidecar starts each utterance with `version: "local-stt.v1"`, mono `16000` Hz `pcm_s16le`, `frame_ms: 20`, and `bytes_per_frame: 640`. The shim must not base64-wrap hot-path audio when talking to `rtc-asr`.

## Server Events

The shim translates Local STT v1 events into Realtime-style UI events without leaking backend-specific assumptions:

- `ready` becomes a session or input-buffer readiness signal.
- Partial `transcript` events become incremental user-transcript deltas.
- Final `transcript` events become committed user-turn text and trigger the local LLM step.
- LLM text deltas become assistant text events.
- Kokoro PCM output becomes output-audio buffer delta events with matching transcript text where available.
- `warning` events are attached to session diagnostics and may continue the turn.
- `error` events fail closed with a visible recoverable or terminal error, depending on `fatal` and `retryable`.
- `closed` completes the voice session shutdown path.

Output audio should use one declared format for the first proof, preferably mono PCM16 at the playback sample rate chosen by the browser bridge. If the browser voice entrypoint expects a different encoding, the shim owns resampling or encoding at the edge.

## Interruption And Cancel Semantics

The UI-level interruption contract is stricter than the STT lifecycle:

- Canceling an assistant response stops local TTS immediately and marks subsequent TTS chunks stale.
- User barge-in should first cancel output audio, then start or continue a new input audio utterance.
- Clearing input audio must not emit a final transcript or dispatch an LLM request.
- A Local STT `error` during active input should close that utterance and return a recoverable UI error when retryable, otherwise fail closed to manual fallback.
- Close should be idempotent from the UI perspective, even if one sidecar has already closed.

## First Proof Path

The smallest useful proof is a local websocket shim with mocked LLM and mocked or file-backed Kokoro output:

1. Create a session that declares PCM16 input and output support.
2. Send Local STT v1 `start`, stream at least one binary PCM16 frame, and receive `ready` plus a partial or final transcript.
3. Commit with Local STT v1 `finalize` and convert the final transcript into one deterministic assistant text response.
4. Emit at least one output-audio delta and a response-done event.
5. Exercise `input_audio_buffer.clear` through Local STT v1 `cancel` and prove no final transcript is dispatched.
6. Exercise a Local STT v1 `error` path and prove the UI receives a bounded error instead of a hanging response.

This contract confirms that `rtc-asr` issue `#203` is useful: the sidecar should add a local contract check that covers `start`, binary PCM16 audio, partial/final transcript events, `finalize`, `cancel`, `error`, and `close` without OpenClaw-specific code.

## Ownership

- `agentic-contact-center`: keeps this adapter contract, mocked response policy, and demo fallback behavior.
- `rtc-asr`: owns Local STT v1 lifecycle checks and any sidecar benchmark artifacts.
- Future OpenClaw integration: owns the actual web voice entrypoint wiring while preserving the existing microphone control as much as possible.
