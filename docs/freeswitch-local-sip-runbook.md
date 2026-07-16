# FreeSWITCH Local SIP Live Proof

This path avoids production SignalWire credentials and public exposure. It uses a local SIP extension first, while preserving the same `/api/live-sip/events` adapter for future SignalWire SIP trunk inbound calls.

For the shared Pipecat media-engine contract, run ACC and inspect:

```sh
curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness
```

That route is the Issue #214/#222 review surface for browser WebRTC, local SIP/FreeSWITCH, and future SignalWire SIP trunk audio. The preferred local SIP path is now a live FreeSWITCH Verto/WebRTC agent leg: Linphone calls `8600`, FreeSWITCH bridges the call to registered user `acc-pipecat`, and the Pipecat sidecar must answer that WebRTC leg so caller PCM streams to rtc-asr/ACC/Kokoro and return audio is heard in the same active call.

## Ports and credentials

- Agentic Contact Center: `http://127.0.0.1:8026`
- FreeSWITCH SIP profile: `127.0.0.1:5060/UDP` or Docker-published `5060/UDP`
- FreeSWITCH ESL: `127.0.0.1:8021`, password `ClueCon`
- FreeSWITCH Verto: `ws://127.0.0.1:8081`, WSS on `127.0.0.1:8082`
- Local SIP account: extension `1000`, password `local-sip-pass`, domain `127.0.0.1`
- ACC destination: dial `8600`
- Preferred Verto agent: `acc-pipecat@127.0.0.1`, password `local-verto-pass`
- RTP range in compose: `16384-16484/UDP`

## Local harness without FreeSWITCH

Use this only to verify the SIP/RTP capture code path. A self-test is generated media and is not review-ready.

```sh
npm run build
node dist/src/index.js
node scripts/local-sip-live-proof.mjs --self-test --acc-url http://127.0.0.1:8026 --out-dir artifacts/local-sip-selftest
```

Expected artifacts:

- `artifacts/local-sip-selftest/caller-capture.wav`
- `artifacts/local-sip-selftest/sip.log.json`
- `artifacts/local-sip-selftest/local-sip-live-proof-manifest.json` with `reviewReady: false` and `generated_media`

## FreeSWITCH local SIP proof

1. Start ACC:

```sh
npm run build
PORT=8026 npm start
```

2. Start FreeSWITCH with the local config. The compose profile uses the public `safarov/freeswitch:latest` image. If ACC is already running locally on `127.0.0.1:8026`, start only FreeSWITCH:

```sh
npm run docker:freeswitch:only
```

Use `npm run docker:freeswitch` instead when you want compose to build and start both ACC and FreeSWITCH together.

Use `npm run docker:sip-verto` when you want Compose to start the preferred #222 local SIP lab stack: ACC, FreeSWITCH, rtc-asr, Kokoro, and the Pipecat Verto/WebRTC sidecar. That path expects a compatible `rtc-asr` image, defaulting to `rtc-asr:local`, exposes FreeSWITCH Verto on `127.0.0.1:8081`/`8082`, and keeps extension `8600` bridged to `acc-pipecat`.

The Compose sidecar mounts `./artifacts` and writes its call-scoped proof to `artifacts/freeswitch-live/pipecat-verto-proof.json`.

Use `npm run docker:sip` only for the legacy ESL/RTP proof-debug lane. That bridge can still write bundle-compatible artifacts, but it is not the accepted #222 route.

3. Start the Pipecat Verto sidecar from another terminal when not using Compose:

```sh
FREESWITCH_VERTO_URL=ws://127.0.0.1:8081 FREESWITCH_VERTO_LOGIN=acc-pipecat@127.0.0.1 FREESWITCH_VERTO_PASSWORD=local-verto-pass PIPECAT_VERTO_PROOF_OUT=artifacts/freeswitch-live/pipecat-verto-proof.json npm run pipecat:verto
```

The sidecar updates `PIPECAT_VERTO_PROOF_OUT` after login, invite, and pipeline stage events. It includes the call-scoped rtc-asr final transcript and Kokoro TTS evidence needed by the strict caller harness.

To run the deterministic two-way proof, create or supply a PCM16 WAV containing a spoken caller utterance, then run:

```sh
FREESWITCH_SIP_PASSWORD=local-sip-pass \
  ACC_SIP_PROOF_LOCAL_HOST=192.168.86.28 \
  npm run pipecat:verto:live-proof -- \
  --caller-audio artifacts/caller-speech.wav \
  --rtc-asr-evidence artifacts/freeswitch-live/pipecat-verto-proof.json \
  --out-dir artifacts/freeswitch-live/caller \
  --require-review-ready
```

Set `ACC_SIP_PROOF_LOCAL_HOST` to a non-loopback IPv4 address on the caller host that the FreeSWITCH container can reach. On macOS, `ipconfig getifaddr en0` is a common way to find it; on Linux, inspect `hostname -I`. The harness rejects `127.0.0.1` because container loopback points back into the FreeSWITCH container, not to the caller RTP socket. If the variable is omitted, the harness infers the first non-loopback IPv4 interface and fails fast when none is available.

The harness keeps RTP flowing after the utterance, captures return RTP at the caller, and only reports `reviewReady: true` when the evidence contains a current rtc-asr final transcript plus Kokoro output and the caller capture contains at least ten non-silent PCMU packets. It also writes `rtc-asr-transcript-evidence.json`, normalized to the current SIP Call-ID, so the manifest can be passed directly to `npm run proof:live-sip-bundle -- --require-rtc-asr-live --require-caller-playback`.

The legacy ESL bridge can still be started for diagnostics and bundle scaffolding:

```sh
ACC_BASE_URL=http://127.0.0.1:8026 KOKORO_BASE_URL=http://127.0.0.1:8880 node scripts/freeswitch-acc-bridge.mjs --recording-dir artifacts/freeswitch-live/media --freeswitch-recording-dir /var/log/freeswitch/acc/media --log artifacts/freeswitch-live/freeswitch-esl-events.json
```

The accepted #222 proof must come from the active Verto/WebRTC call leg, not post-hangup transcription or a `uuid_broadcast`-only diagnostic artifact.

4. Register a local SIP softphone:

```text
User: 1000
Password: local-sip-pass
Domain/proxy: 127.0.0.1:5060
Transport: UDP
Dial: 8600
```

If using an already-running native/Homebrew FreeSWITCH instead of the compose service, confirm its active password before running SIPp or configuring a softphone:

```sh
fs_cli -x 'global_getvar default_password'
```

On Alberto's current local Homebrew FreeSWITCH, the active SIP profile binds to `192.168.86.28:5060` and extension `1000` uses the `default_password` value rather than the compose-only `local-sip-pass`.

5. Speak a real caller utterance, then hang up. Review:

```sh
ls -lh artifacts/freeswitch-live/media/*.wav artifacts/freeswitch-live/freeswitch-esl-events.json
curl http://127.0.0.1:8026/api/calls?limit=5
npm run proof:live-sip-bundle -- --live-manifest artifacts/freeswitch-live/freeswitch-live-proof-manifest.json --out-dir artifacts/freeswitch-live-bundle
```

## rtc-asr live transcript

When rtc-asr is running, set:

```sh
export RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream
```

If `RTC_ASR_WS_URL` is absent, the bridge records an explicit `rtc_asr_blocked` event instead of fabricating a transcript.

## SignalWire inbound readiness

When Alberto approves credentials/DID routing, point the SignalWire SIP trunk at FreeSWITCH, route the DID to extension `8600`, and run the same bridge with:

```sh
ACC_TELEPHONY_MODE=signalwire_live ACC_BASE_URL=http://127.0.0.1:8026 node scripts/freeswitch-acc-bridge.mjs
```

No production SignalWire secrets are stored in this repo.

SignalWire past-call ingestion is not covered by this live SIP path. If historical call import is needed, add a separate importer; the realtime path remains SignalWire SIP trunk -> FreeSWITCH -> Pipecat.
