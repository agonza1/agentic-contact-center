import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

test("Docker runtime assets keep the documented health and proof contract", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8").replace(/\r\n/g, "\n");
  const freeswitchDialplan = readFileSync(join(repoRoot, "freeswitch", "conf", "dialplan", "default", "acc_local_sip.xml"), "utf8");
  const freeswitchEventSocket = readFileSync(join(repoRoot, "freeswitch", "conf", "autoload_configs", "event_socket.conf.xml"), "utf8");
  const freeswitchLogfile = readFileSync(join(repoRoot, "freeswitch", "conf", "autoload_configs", "logfile.conf.xml"), "utf8");
  const freeswitchLocalSipProfile = readFileSync(join(repoRoot, "freeswitch", "conf", "sip_profiles", "acc-local.xml"), "utf8");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const runtimeReference = readFileSync(join(repoRoot, "docs", "runtime-reference.md"), "utf8");
  const codexVoiceBridge = readFileSync(join(repoRoot, "scripts", "codex-voice-bridge.py"), "utf8");
  const codexVoiceRequirements = readFileSync(join(repoRoot, "config", "codex-voice-requirements.toml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.match(dockerfile, /FROM node:20-bookworm-slim AS runtime/);
  assert.match(dockerfile, /ENV PORT=8026/);
  assert.match(dockerfile, /EXPOSE 8026/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*scripts\/health-smoke\.mjs/);
  assert.match(dockerfile, /--expect-pipecat-prototype-mode pipecat_local_runtime/);
  assert.match(dockerfile, /--expect-pipecat-runtime-check-command "npm run pipecat:check"/);
  assert.match(dockerfile, /--expect-production-ready false/);
  assert.match(dockerfile, /--expect-production-readiness-blocker provider_credentials_mocked/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/index\.js"\]/);

  assert.match(compose, /app:\n[\s\S]*target: runtime/);
  assert.match(compose, /app:\n[\s\S]*restart: unless-stopped/);
  assert.match(compose, /app:\n[\s\S]*ports:\n[\s\S]*- "127\.0\.0\.1:8026:8026"/);
  assert.doesNotMatch(compose, /app:\n[\s\S]*ports:\n[\s\S]*- "8026:8026"/);
  assert.match(compose, /app:\n[\s\S]*healthcheck:/);
  assert.match(compose, /app:\n[\s\S]*scripts\/health-smoke\.mjs/);
  assert.match(compose, /app:\n[\s\S]*--timeout-ms\n\s+- "8000"/);
  assert.match(compose, /app:\n[\s\S]*timeout: 10s/);
  assert.match(compose, /app:\n[\s\S]*--expect-pipecat-prototype-mode/);
  assert.match(compose, /app:\n[\s\S]*npm run pipecat:check/);
  assert.match(compose, /app:\n[\s\S]*--expect-production-ready/);
  assert.match(compose, /app:\n[\s\S]*provider_credentials_mocked/);
  assert.match(compose, /app:\n[\s\S]*RTC_ASR_WS_URL: \$\{RTC_ASR_BROWSER_WS_URL:-\/api\/cluecon\/asr\/stream\}/);
  assert.equal((compose.match(/ACC_TTS_PROVIDER: \$\{ACC_TTS_PROVIDER:-\}/g) ?? []).length, 3);
  assert.doesNotMatch(compose, /ACC_TTS_PROVIDER: \$\{ACC_TTS_PROVIDER:-kokoro\}/);
  assert.equal((compose.match(/POCKET_TTS_BASE_URL: \$\{POCKET_TTS_CONTAINER_BASE_URL:-\}/g) ?? []).length, 3);
  assert.equal((compose.match(/POCKET_TTS_HEALTH_PATH: \$\{POCKET_TTS_HEALTH_PATH:-\/health\}/g) ?? []).length, 3);
  assert.equal((compose.match(/POCKET_TTS_SPEECH_PATH: \$\{POCKET_TTS_SPEECH_PATH:-\/v1\/audio\/speech\}/g) ?? []).length, 3);
  assert.equal((compose.match(/"host\.docker\.internal:host-gateway"/g) ?? []).length, 3);
  assert.match(compose, /\.\/freeswitch\/conf\/sip_profiles\/internal\.xml:\/etc\/freeswitch\/sip_profiles\/internal\.xml:ro/);
  assert.doesNotMatch(compose, /POCKET_TTS_BASE_URL: \$\{POCKET_TTS_BASE_URL:-http:\/\/127\.0\.0\.1:8881\}/);
  assert.doesNotMatch(compose, /POCKET_TTS_BASE_URL: \$\{POCKET_TTS_CONTAINER_BASE_URL:-http:\/\/host\.docker\.internal:8881\}/);
  assert.match(compose, /proof:\n[\s\S]*profiles: \["proof"\]/);
  assert.match(compose, /proof:\n[\s\S]*scripts\/demo-proof\.mjs/);
  assert.match(compose, /proof:\n[\s\S]*artifacts\/demo-proof-docker\.json/);
  assert.match(compose, /proof:\n[\s\S]*\.\/artifacts:\/app\/artifacts/);
  assert.match(compose, /rtc-asr:\n[\s\S]*profiles: \["voice", "browser-webrtc", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /rtc-asr:\n[\s\S]*restart: unless-stopped/);
  assert.match(compose, /rtc-asr:\n[\s\S]*ASR_BACKEND: \$\{ASR_BACKEND:-parakeet-nemo\}/);
  assert.match(compose, /rtc-asr:\n[\s\S]*ASR_PARAKEET_MODEL: \$\{ASR_PARAKEET_MODEL:-nvidia\/parakeet-tdt_ctc-110m\}/);
  assert.match(compose, /rtc-asr:\n[\s\S]*HF_HUB_DISABLE_XET: \$\{HF_HUB_DISABLE_XET:-1\}/);
  assert.match(compose, /rtc-asr:\n[\s\S]*\/ready[\s\S]*payload\.get\("ready"\) is True[\s\S]*payload\.get\("model_loaded"\) is True/);
  assert.match(compose, /rtc-asr:\n[\s\S]*start_period: 10m/);
  assert.match(compose, /rtc-asr:\n[\s\S]*ASR_VAD_FILTER: \${ASR_VAD_FILTER:-false}/);
  assert.match(compose, /kokoro:\n[\s\S]*profiles: \["voice", "browser-webrtc", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /browser-webrtc-bridge:\n[\s\S]*target: voice-runtime/);
  assert.match(compose, /browser-webrtc-bridge:\n[\s\S]*RTC_ASR_WS_URL: ws:\/\/rtc-asr:8080\/v1\/stt\/stream/);
  assert.match(compose, /freeswitch:\n[\s\S]*profiles: \["freeswitch", "sip", "sip-verto", "full"\]/);
  assert.match(compose, /freeswitch:\n[\s\S]*"127\.0\.0\.1:8081:8081\/tcp"/);
  assert.match(compose, /freeswitch:\n[\s\S]*"127\.0\.0\.1:5060:5060\/udp"/);
  assert.match(compose, /freeswitch:\n[\s\S]*"127\.0\.0\.1:5060:5060\/tcp"/);
  assert.match(compose, /freeswitch:\n[\s\S]*"127\.0\.0\.1:8021:8021\/tcp"/);
  assert.doesNotMatch(freeswitchEventSocket, /apply-inbound-acl/);
  assert.match(freeswitchLogfile, /\/var\/log\/freeswitch\/acc\/freeswitch\.log/);
  assert.match(freeswitchLocalSipProfile, /apply-candidate-acl" value="rfc1918\.auto"/);
  assert.match(freeswitchLocalSipProfile, /apply-candidate-acl" value="loopback\.auto"/);
  assert.match(freeswitchLocalSipProfile, /ext-sip-ip" value="127\.0\.0\.1"/);
  assert.match(freeswitchLocalSipProfile, /ext-sip-port" value="5060"/);
  assert.match(freeswitchLocalSipProfile, /sip-port" value="5060"/);
  assert.match(compose, /freeswitch:\n[\s\S]*freeswitch\/conf\/sip_profiles\/acc-local\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*freeswitch\/conf\/directory\/localhost\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*freeswitch\/conf\/autoload_configs\/switch\.conf\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*freeswitch\/conf\/autoload_configs\/logfile\.conf\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*acc-pipecat\.xml/);
  assert.match(compose, /freeswitch:\n[\s\S]*verto\.conf\.xml/);
  assert.match(freeswitchDialplan, /acc_linked_sip_call_id=\$\{uuid\}/);
  assert.match(freeswitchDialplan, /acc_proof_sip_call_id=\$\{sip_h_X-ACC-Proof-Call-ID\}/);
  assert.match(freeswitchDialplan, /export" data="nolocal:sip_h_X-ACC-Proof-Call-ID=\$\{sip_h_X-ACC-Proof-Call-ID\}"/);
  assert.match(freeswitchDialplan, /agentic_contact_center_local_sip_openai_8600/);
  assert.match(freeswitchDialplan, /agentic_contact_center_local_sip_free_caller_8611/);
  assert.match(freeswitchDialplan, /agentic_contact_center_local_sip_scripted_failure_8612/);
  assert.match(freeswitchDialplan, /sip_h_X-ACC-Conversation-Mode=openai_llm/);
  assert.match(freeswitchDialplan, /sip_h_X-ACC-Conversation-Mode=free_caller/);
  assert.match(freeswitchDialplan, /sip_h_X-ACC-Conversation-Mode=scripted/);
  assert.match(freeswitchDialplan, /sip_h_X-ACC-Proof-Call-ID=\$\{sip_h_X-ACC-Proof-Call-ID\}/);
  assert.match(freeswitchDialplan, /rtp_jitter_buffer_during_bridge=true/);
  assert.match(freeswitchDialplan, /bridge" data="\{absolute_codec_string=PCMU,origination_caller_id_name=ACC-8600,jitterbuffer_msec=60:200:20,[^"]*acc_conversation_mode=openai_llm[^"]*\}\$\{verto_contact\(acc-pipecat@\$\$\{domain\}\)\}"/);
  assert.match(freeswitchDialplan, /bridge" data="\{absolute_codec_string=PCMU,origination_caller_id_name=ACC-8611,jitterbuffer_msec=60:200:20,[^"]*acc_conversation_mode=free_caller[^"]*\}\$\{verto_contact\(acc-pipecat@\$\$\{domain\}\)\}"/);
  assert.match(freeswitchDialplan, /bridge" data="\{absolute_codec_string=PCMU,origination_caller_id_name=ACC-8612,jitterbuffer_msec=60:200:20,[^"]*acc_conversation_mode=scripted[^"]*\}\$\{verto_contact\(acc-pipecat@\$\$\{domain\}\)\}"/);
  assert.match(compose, /freeswitch-bridge:\n[\s\S]*scripts\/freeswitch-acc-bridge\.mjs/);
  assert.match(compose, /freeswitch-bridge:\n[\s\S]*ACC_VERTO_OWNS_GREETING: \${ACC_VERTO_OWNS_GREETING:-false}/);
  assert.match(compose, /freeswitch-bridge:\n[\s\S]*ACC_VERTO_OWNS_MEDIA: \${ACC_VERTO_OWNS_MEDIA:-false}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*target: voice-runtime/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*scripts\/pipecat-verto-agent-bridge\.py/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*working_dir: \/tmp/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_VERTO_AUDIO_OUT_SAMPLE_RATE: \$\{ACC_VERTO_AUDIO_OUT_SAMPLE_RATE:-8000\}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_WEBRTC_SILENCE_RMS: \$\{ACC_WEBRTC_SILENCE_RMS:-120\}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_TTS_REQUEST_TIMEOUT_SEC: \$\{ACC_TTS_REQUEST_TIMEOUT_SEC:-60\}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_HEALTH_PATH: \/api\/pipecat-media-engine\/readiness/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*RTC_ASR_HEALTH_PATH: \/ready/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_VOICE_READINESS_TIMEOUT_SEC: "3"/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*\.\/artifacts:\/app\/artifacts/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_VERTO_OWNS_GREETING: \${ACC_VERTO_OWNS_GREETING:-true}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_SIP_GREETING_PREROLL_MS: \${ACC_SIP_GREETING_PREROLL_MS:-300}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_TTS_CACHE_DIR: \${ACC_TTS_CACHE_DIR:-\/app\/artifacts\/tts-cache}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_TTS_OUTPUT_CHUNK_YIELD_MS: \${ACC_TTS_OUTPUT_CHUNK_YIELD_MS:-20}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*ACC_TTS_EVIDENCE_EVERY_N_CHUNKS: \${ACC_TTS_EVIDENCE_EVERY_N_CHUNKS:-50}/);
  assert.match(compose, /pipecat-verto-bridge:\n[\s\S]*PIPECAT_VERTO_PROOF_OUT: \/app\/artifacts\/freeswitch-live\/pipecat-verto-proof\.json/);
  assert.match(compose, /codex-voice-bridge:\n[\s\S]*scripts\/codex-voice-bridge\.py/);
  assert.match(compose, /codex-voice-bridge:\n[\s\S]*"127\.0\.0\.1:8771:8771"/);
  assert.match(compose, /codex-voice-bridge:\n[\s\S]*codex-voice-auth:\/root\/\.codex/);
  assert.match(compose, /codex-voice-bridge:\n[\s\S]*\.\/config\/codex-voice-requirements\.toml:\/etc\/codex\/requirements\.toml:ro/);
  assert.match(codexVoiceBridge, /"shell_tool": False/);
  assert.match(codexVoiceBridge, /"web_search": "disabled"/);
  assert.match(codexVoiceBridge, /config=VOICE_THREAD_CONFIG/);
  assert.match(codexVoiceBridge, /call = self\._start_thread\(\) if stateless else self\._call_thread/);
  assert.match(codexVoiceBridge, /"stateless": stateless/);
  assert.match(codexVoiceRequirements, /allowed_approval_policies = \["never"\]/);
  assert.match(codexVoiceRequirements, /allowed_sandbox_modes = \["read-only"\]/);
  assert.match(codexVoiceRequirements, /allowed_web_search_modes = \[\]/);
  assert.match(codexVoiceRequirements, /\[mcp_servers\]/);
  assert.match(codexVoiceRequirements, /shell_tool = false/);
  assert.match(codexVoiceRequirements, /plugins = false/);
  assert.match(compose, /app:\n[\s\S]*ACC_OPENAI_CONVERSATION_MODEL: \${ACC_OPENAI_CONVERSATION_MODEL:-gpt-5\.4-mini}/);
  assert.match(compose, /app:\n[\s\S]*ACC_OPENAI_AUTH_MODE: \${ACC_OPENAI_AUTH_MODE:-codex_oauth}/);
  assert.match(compose, /app:\n[\s\S]*ACC_CODEX_VOICE_BRIDGE_URL: http:\/\/codex-voice-bridge:8771/);
  assert.match(compose, /app:\n[\s\S]*ACC_OPENAI_API_KEY: \${ACC_OPENAI_API_KEY:-}/);
  assert.match(compose, /assert-viewer:\n[\s\S]*target: assert-runtime/);
  assert.match(compose, /assert-viewer:\n[\s\S]*scripts\/assert-viewer\.mjs/);

  assert.equal(packageJson.scripts?.["docker:app"], "docker compose up --build app");
  assert.equal(packageJson.scripts?.["health:smoke"], "node scripts/health-smoke.mjs --url http://127.0.0.1:8026/health");
  assert.equal(
    packageJson.scripts?.["docker:smoke"],
    "sh -c 'cleanup(){ docker compose down --remove-orphans; }; trap cleanup EXIT; docker compose up --build -d app && node scripts/health-smoke.mjs --url http://127.0.0.1:8026/health'",
  );
  assert.equal(
    packageJson.scripts?.["docker:proof"],
    "sh -c 'LOCAL_UID=${LOCAL_UID:-$(id -u)} LOCAL_GID=${LOCAL_GID:-$(id -g)} docker compose run --rm proof'",
  );
  assert.equal(packageJson.scripts?.["docker:voice"], "docker compose --profile voice up --build app rtc-asr kokoro");
  assert.equal(
    packageJson.scripts?.["docker:browser-webrtc"],
    "docker compose --profile browser-webrtc up --build app rtc-asr kokoro browser-webrtc-bridge",
  );
  assert.equal(
    packageJson.scripts?.["docker:sip-verto"],
    "docker compose --profile sip-verto up --build app freeswitch rtc-asr kokoro codex-voice-bridge pipecat-verto-bridge",
  );
  assert.equal(packageJson.scripts?.["pipecat:verto:live-proof"], "node scripts/verto-sip-live-proof.mjs");
  assert.equal(packageJson.scripts?.["signalwire:freeswitch:readiness"], "node scripts/signalwire-freeswitch-readiness.mjs");
  assert.equal(packageJson.scripts?.["docker:sip"], "docker compose --profile sip up --build app freeswitch rtc-asr kokoro freeswitch-bridge");
  assert.equal(packageJson.scripts?.["docker:assert"], "docker compose --profile eval up --build assert-viewer");
  assert.equal(packageJson.scripts?.["docker:full"], "ACC_VERTO_OWNS_GREETING=true ACC_VERTO_OWNS_MEDIA=true docker compose --profile full up --build");
  assert.equal(packageJson.scripts?.["docker:freeswitch:only"], "docker compose --profile freeswitch up -d freeswitch --no-deps");
  assert.match(readme, /npm run docker:app/);
  assert.match(readme, /npm run docker:smoke/);
  assert.match(readme, /npm run health:smoke/);
  assert.match(readme, /npm run docker:proof/);
  assert.match(readme, /npm run docker:voice/);
  assert.match(readme, /npm run docker:browser-webrtc/);
  assert.match(readme, /npm run docker:sip-verto/);
  assert.match(readme, /npm run signalwire:freeswitch:readiness/);
  assert.match(readme, /npm run docker:sip/);
  assert.match(readme, /npm run docker:assert/);
  assert.match(readme, /npm run docker:full/);
  assert.match(readme, /npm run docker:freeswitch:only/);
  const normalBrowserWebrtcSetup = runtimeReference
    .slice(runtimeReference.indexOf("Normal browser WebRTC sidecar setup:"))
    .split("```", 3)[1];
  assert.match(normalBrowserWebrtcSetup, /export ACC_TTS_PROVIDER=kokoro/);
  assert.match(normalBrowserWebrtcSetup, /export KOKORO_BASE_URL=http:\/\/127\.0\.0\.1:8880/);
  assert.doesNotMatch(normalBrowserWebrtcSetup, /POCKET_TTS_BASE_URL/);
  assert.match(runtimeReference, /If a Pocket proof is needed instead, start the Pocket TTS service first/);
});
