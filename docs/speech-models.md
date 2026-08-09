# Enable live STT and TTS models

The ClueCon presentation can use real local speech models in the **Live ASR lab** and **Live TTS latency lab**. ACC does not load speech models directly:

```text
microphone -> rtc-asr -> ACC / Pipecat -> Pocket or Kokoro -> browser
              STT          contracts          TTS
```

- `rtc-asr` owns the STT backend and exposes HTTP readiness plus the Local STT v1 WebSocket.
- Pocket TTS or Kokoro owns synthesis and exposes an OpenAI-compatible streaming speech endpoint.
- ACC probes those sidecars and proxies their streams to the presentation. It does not fabricate live latency measurements.

The examples below use Windows PowerShell and the ports used by the local presentation:

| Service | URL | Purpose |
| --- | --- | --- |
| ACC / ClueCon | `http://127.0.0.1:8026` | Presentation and speech proxy |
| rtc-asr | `http://127.0.0.1:8080` | Local STT HTTP and WebSocket service |
| Kokoro | `http://127.0.0.1:8880` | Local TTS option |
| Pocket TTS | `http://127.0.0.1:8881` | Local TTS option |

## Fast path: Parakeet 110M plus one TTS engine

Start the model sidecars first. Set the matching ACC environment variables, then run `npm run cluecon`. ACC reads model configuration at process startup, so restart the presentation server after changing providers, models, voices, or URLs.

### 1. Start Parakeet 110M with rtc-asr

Keep [rtc-asr](https://github.com/agonza1/rtc-asr) next to this repository:

```powershell
git clone https://github.com/agonza1/rtc-asr.git ..\rtc-asr
```

The clone command is needed only when the sibling checkout does not already exist. Build the NeMo runtime and preload the 110M model:

```powershell
Push-Location ..\rtc-asr
$env:ENABLE_NEMO_RUNTIME = "1"
$env:ASR_BACKEND = "parakeet-nemo"
$env:ASR_PARAKEET_MODEL = "nvidia/parakeet-tdt_ctc-110m"
$env:ASR_PRELOAD_MODEL = "true"
docker compose up -d --build asr-service
Pop-Location
```

`ENABLE_NEMO_RUNTIME=1` is a Docker build option. Keep it set whenever rebuilding the rtc-asr image. The other variables select and preload the runtime model. Once that image exists, normal restarts can omit `--build`, but they must retain the backend, model, and preload selection:

```powershell
Push-Location ..\rtc-asr
$env:ASR_BACKEND = "parakeet-nemo"
$env:ASR_PARAKEET_MODEL = "nvidia/parakeet-tdt_ctc-110m"
$env:ASR_PRELOAD_MODEL = "true"
docker compose up -d asr-service
Pop-Location
```

For repeatable startup across new shells, put those four settings, including `ENABLE_NEMO_RUNTIME=1`, in `..\rtc-asr\.env`. Docker Compose reads that file automatically.

Wait for both probes to succeed before presenting:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
Invoke-RestMethod http://127.0.0.1:8080/ready
```

The `/ready` payload should report:

```text
backend: parakeet-nemo
model: nvidia/parakeet-tdt_ctc-110m
ready: true
model_loaded: true
```

The first build downloads NeMo dependencies and the first startup downloads the model. Do not benchmark that cold path. Keep `ASR_PRELOAD_MODEL=true`, wait for `/ready`, and run a short warm-up transcription before collecting presentation numbers.

### 2A. Start Kokoro

Kokoro is the TTS sidecar bundled with ACC's Compose profiles:

```powershell
docker compose --profile voice up -d kokoro
Invoke-RestMethod http://127.0.0.1:8880/health
```

Select it for ACC:

```powershell
$env:ACC_TTS_PROVIDER = "kokoro"
$env:KOKORO_BASE_URL = "http://127.0.0.1:8880"
$env:KOKORO_MODEL = "kokoro"
$env:KOKORO_VOICE = "af_heart"
```

For a GPU-backed Kokoro server, use the GPU override instead:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile voice up -d kokoro
```

Docker must have access to a supported GPU for that command.

### 2B. Start Pocket TTS

Use this option instead of Kokoro when testing Pocket. ACC expects `GET /health` and an OpenAI-compatible `POST /v1/audio/speech`. The official Pocket CLI exposes a different `/tts` request shape, so use an OpenAI-compatible adapter such as the community server linked from the [Pocket TTS project](https://github.com/kyutai-labs/pocket-tts):

```powershell
git clone https://github.com/teddybear082/pocket-tts-openai_streaming_server.git ..\pocket-tts-openai-streaming-server
Push-Location ..\pocket-tts-openai-streaming-server
$env:POCKET_TTS_PORT = "8881"
$env:POCKET_TTS_QUANTIZE = "true"
docker compose up -d --build
Pop-Location
Invoke-RestMethod http://127.0.0.1:8881/health
```

The clone and build are one-time setup steps. On later runs:

```powershell
Push-Location ..\pocket-tts-openai-streaming-server
$env:POCKET_TTS_PORT = "8881"
$env:POCKET_TTS_QUANTIZE = "true"
docker compose up -d
Pop-Location
```

Configure ACC to use a built-in Pocket voice and WAV streaming:

```powershell
$env:ACC_TTS_PROVIDER = "pocket"
$env:POCKET_TTS_BASE_URL = "http://127.0.0.1:8881"
$env:POCKET_TTS_MODEL = "pocket-tts"
$env:POCKET_TTS_VOICE = "alba"
$env:POCKET_TTS_RESPONSE_FORMAT = "wav"
```

Use `alba`, not the generic OpenAI example voice `alloy`, unless your Pocket adapter explicitly defines an `alloy` voice. WAV matters for this server's incremental path; MP3 is generated as a completed file and does not demonstrate true chunk streaming.

Prewarm both the model and selected voice before measuring latency:

```powershell
$body = @{
  model = "pocket-tts"
  voice = "alba"
  input = "Ready."
  response_format = "wav"
  stream = $true
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri http://127.0.0.1:8881/v1/audio/speech `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  -OutFile "$env:TEMP\pocket-ready.wav"
```

## 3. Start the ClueCon presentation

From the ACC repository, keep the STT endpoint explicit and retain the TTS variables from the selected section above:

```powershell
$env:RTC_ASR_BASE_URL = "http://127.0.0.1:8080"
$env:RTC_ASR_WS_URL = "ws://127.0.0.1:8080/v1/stt/stream"
npm install
npm run cluecon
```

Open:

- `http://127.0.0.1:8026/cluecon#asr` for the Live ASR lab.
- `http://127.0.0.1:8026/cluecon#tts` for the Live TTS latency lab.

`npm run cluecon` checks `/health` and `/ready` before starting ACC. If rtc-asr is absent at the loopback default and `../rtc-asr` exists, the launcher builds and starts that sibling service using the current `ASR_*` and `ENABLE_NEMO_RUNTIME` variables. It discovers Kokoro automatically at port `8880`; Pocket remains explicit so the intended engine and voice are unambiguous.

## Verify the complete path

### STT discovery

```powershell
Invoke-RestMethod http://127.0.0.1:8026/api/cluecon/asr/models
```

Confirm that the active model is `nvidia/parakeet-tdt_ctc-110m`, then use **Start realtime** or **Batch 6 seconds** on the ASR slide.

### TTS through ACC

The browser slide uses ACC's proxy, not the sidecar directly. Test the same route before presenting:

```powershell
$body = @{
  provider = "pocket"
  voice = "alba"
  text = "Here is the key."
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri http://127.0.0.1:8026/api/cluecon/tts/synthesize `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  -OutFile "$env:TEMP\pocket-through-acc.wav"
```

For Kokoro, change `provider` to `kokoro`, `voice` to `af_heart`, and the output filename as desired. A successful response is real audio. In the presentation, **First audio** measures provider bytes reaching the browser, **Playback** waits for the browser's playing event, and **Total stream** ends after all ordered chunks arrive.

## Configuration reference

### rtc-asr / STT

| Variable | Example | Meaning |
| --- | --- | --- |
| `RTC_ASR_REPO` | `..\rtc-asr` | Sibling checkout used by the ClueCon auto-launcher |
| `RTC_ASR_BASE_URL` | `http://127.0.0.1:8080` | HTTP health, readiness, models, and batch transcription base URL |
| `RTC_ASR_WS_URL` | `ws://127.0.0.1:8080/v1/stt/stream` | Persistent Local STT v1 stream used for realtime audio |
| `ASR_BACKEND` | `parakeet-nemo` | Backend loaded by rtc-asr |
| `ASR_PARAKEET_MODEL` | `nvidia/parakeet-tdt_ctc-110m` | Exact NeMo Parakeet model identifier |
| `ASR_PRELOAD_MODEL` | `true` | Loads and validates the model before `/ready` succeeds |
| `ENABLE_NEMO_RUNTIME` | `1` | Includes NeMo dependencies when building the rtc-asr Docker image |

### TTS selection

| Variable | Kokoro example | Pocket example | Meaning |
| --- | --- | --- | --- |
| `ACC_TTS_PROVIDER` | `kokoro` | `pocket` | TTS provider selected by ACC |
| Base URL | `KOKORO_BASE_URL=http://127.0.0.1:8880` | `POCKET_TTS_BASE_URL=http://127.0.0.1:8881` | Provider endpoint reachable from ACC |
| Model | `KOKORO_MODEL=kokoro` | `POCKET_TTS_MODEL=pocket-tts` | Model value sent to `/v1/audio/speech` |
| Voice | `KOKORO_VOICE=af_heart` | `POCKET_TTS_VOICE=alba` | Provider-supported voice |
| Response format | Provider default | `POCKET_TTS_RESPONSE_FORMAT=wav` | Audio format requested from the provider |
| Health path | Provider default `/health` | `POCKET_TTS_HEALTH_PATH=/health` | Readiness probe path |
| Speech path | Provider default `/v1/audio/speech` | `POCKET_TTS_SPEECH_PATH=/v1/audio/speech` | Streaming synthesis path |

When ACC itself runs in Docker, `127.0.0.1` refers to the ACC container. Use Compose service names for containerized sidecars or expose a host service through `host.docker.internal`. For host-local Pocket with the ACC Compose app, set:

```powershell
$env:POCKET_TTS_CONTAINER_BASE_URL = "http://host.docker.internal:8881"
```

## Bash and zsh environment syntax

The service commands are otherwise the same. Replace PowerShell assignments with exports:

```bash
export ASR_BACKEND=parakeet-nemo
export ASR_PARAKEET_MODEL=nvidia/parakeet-tdt_ctc-110m
export ASR_PRELOAD_MODEL=true
export ENABLE_NEMO_RUNTIME=1

export ACC_TTS_PROVIDER=pocket
export POCKET_TTS_BASE_URL=http://127.0.0.1:8881
export POCKET_TTS_MODEL=pocket-tts
export POCKET_TTS_VOICE=alba
export POCKET_TTS_RESPONSE_FORMAT=wav
```

## Troubleshooting

### `rtc-asr unavailable` or `/ready` returns an error

```powershell
docker compose -f ..\rtc-asr\docker-compose.yml logs --tail 200 asr-service
Invoke-RestMethod http://127.0.0.1:8080/ready
```

- Confirm `ENABLE_NEMO_RUNTIME=1` was set when the image was built.
- Confirm the model variable is `ASR_PARAKEET_MODEL`, not `ASR_MODEL_SIZE`.
- Allow the first model download and preload to finish before starting the demo.

### The ASR slide selects a different model

ACC displays what rtc-asr reports; it does not change the upstream model. Recreate rtc-asr with the requested backend and model, verify `/ready`, and restart `npm run cluecon`.

### `local sidecar required`

The provider health probe failed or its base URL was missing when ACC started. Verify the sidecar directly, set its base URL, and restart the presentation server.

### Pocket reports `Voice 'alloy' not found`

Set `POCKET_TTS_VOICE=alba`, restart ACC, and reload the presentation. The browser receives the configured voice from ACC at page load.

### Pocket returns audio but does not stream incrementally

Set `POCKET_TTS_RESPONSE_FORMAT=wav`. The adapter used above streams WAV chunks; its MP3 response is produced as a completed file.

### First-run latency is much slower than the slide's published examples

Separate cold startup from warmed inference. Wait for model readiness, synthesize `Ready.` once for the chosen voice, then run the browser measurement. Hardware, quantization, serving stack, format, and chunk boundaries still affect results.

## Stop the sidecars

Stop only the services you started:

```powershell
docker compose -f ..\rtc-asr\docker-compose.yml stop asr-service
docker compose --profile voice stop kokoro

Push-Location ..\pocket-tts-openai-streaming-server
docker compose stop
Pop-Location
```

Stopping containers preserves their images, model caches, and named volumes for the next presentation run.
