# FreeSWITCH Local SIP Live Proof

This path avoids production SignalWire credentials and public exposure. It uses a local SIP extension first, while preserving the same `/api/live-sip/events` adapter for future SignalWire SIP trunk inbound calls.

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

2. Start FreeSWITCH with the local config. If Docker is available:

```sh
docker compose --profile freeswitch up --build app freeswitch
```

3. Start the ESL bridge from another terminal:

```sh
ACC_BASE_URL=http://127.0.0.1:8026 node scripts/freeswitch-acc-bridge.mjs --recording-dir artifacts/freeswitch-live/media --freeswitch-recording-dir /var/log/freeswitch/acc/media --log artifacts/freeswitch-live/freeswitch-esl-events.json
```

The bridge also writes a bundle-compatible manifest by default:

```text
artifacts/freeswitch-live/freeswitch-live-proof-manifest.json
```

Override it with `--manifest <path>` if needed. If rtc-asr is running and you have a transcript/evidence JSON path, pass `--rtc-asr-evidence <path>` so the manifest can distinguish a configured websocket from attached ASR proof.

4. Register a local SIP softphone:

```text
User: 1000
Password: local-sip-pass
Domain/proxy: 127.0.0.1:5060
Transport: UDP
Dial: 8600
```

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
