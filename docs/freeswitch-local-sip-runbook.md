# FreeSWITCH Local SIP Live Proof

This path avoids production SignalWire credentials and public exposure. It uses a local SIP extension first, while preserving the same `/api/live-sip/events` adapter for future SignalWire SIP trunk inbound calls.

For the shared Pipecat media-engine contract, run ACC and inspect:

```sh
curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness
```

That route is the Issue #214 review surface for browser WebRTC, local SIP/FreeSWITCH, and future SignalWire SIP trunk audio. It currently reports the browser Pipecat voice bridge as implemented and the SIP/FreeSWITCH realtime RTP adapter as blocked; the SIP proof steps below still capture live media/proof artifacts and must not be treated as completed bidirectional Pipecat RTP streaming.

## Ports and credentials

- Agentic Contact Center: `http://127.0.0.1:8026`
- FreeSWITCH SIP profile: `127.0.0.1:5060/UDP` or Docker-published `5060/UDP`
- FreeSWITCH ESL: `127.0.0.1:8021`, password `ClueCon`
- Local SIP account: extension `1000`, password `local-sip-pass`, domain `127.0.0.1`
- ACC destination: dial `8600`
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

3. Start the ESL bridge from another terminal:

```sh
ACC_BASE_URL=http://127.0.0.1:8026 node scripts/freeswitch-acc-bridge.mjs --recording-dir artifacts/freeswitch-live/media --freeswitch-recording-dir /var/log/freeswitch/acc/media --log artifacts/freeswitch-live/freeswitch-esl-events.json
```

The bridge also writes a bundle-compatible manifest by default:

```text
artifacts/freeswitch-live/freeswitch-live-proof-manifest.json
```

Override it with `--manifest <path>` if needed. If rtc-asr is running and you have a transcript/evidence JSON path, pass `--rtc-asr-evidence <path>` so the manifest can distinguish a configured websocket from attached ASR proof.

To collect live inbound PCMU RTP packets into Pipecat-compatible `InputAudioRawFrameBatch` manifest evidence while experimenting with FreeSWITCH media routing, add `--rtp-listen-port <udp-port>` and point the FreeSWITCH RTP stream at that host/port. This proves the SIP RTP -> Pipecat input-frame boundary only; SIP caller playback remains blocked until Kokoro/Pipecat TTS frames are encoded back to FreeSWITCH RTP.

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
