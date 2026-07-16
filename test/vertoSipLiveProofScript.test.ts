import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Verto SIP live proof self-test validates digest, SDP, and RTP packet helpers", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/verto-sip-live-proof.mjs", "--self-test"],
    { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
  );

  const summary = JSON.parse(stdout) as {
    ok: boolean;
    authorizationReady: boolean;
    authorizationUriReady: boolean;
    sdpTarget: { host: string; port: number };
    packetCount: number;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.authorizationReady, true);
  assert.equal(summary.authorizationUriReady, true);
  assert.deepEqual(summary.sdpTarget, { host: "127.0.0.1", port: 29790 });
  assert.ok(summary.packetCount > 0);
});

test("Verto SIP proof requires transcript-backed non-silent caller playback", () => {
  const script = readFileSync("scripts/verto-sip-live-proof.mjs", "utf8");

  assert.match(script, /--caller-audio/);
  assert.match(script, /--tail-silence-ms/);
  assert.match(script, /stt\.transcript_final/);
  assert.match(script, /tts\.audio_ready/);
  assert.match(script, /baselineCallIds\.has\(evidenceCallId\)/);
  assert.match(script, /Date\.parse\(event\.timestamp\) >= startedAtMs/);
  assert.match(script, /this\.returnPacketCount >= 10/);
  assert.match(script, /playbackRms >= 50/);
});

test("Verto bridge normalizes FreeSWITCH ICE, DTLS, and G.711 RTP", { skip: !existsSync(".pipecat-runtime") }, async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const { stdout } = await execFileAsync(
    "python3",
    ["scripts/pipecat-verto-agent-bridge.py", "--sdp-normalization-self-test"],
    { cwd: repoRoot, timeout: 20_000, encoding: "utf8" },
  );
  const summary = JSON.parse(stdout.trim().split("\n").slice(-16).join("\n")) as {
    ok: boolean;
    checks: Record<string, boolean>;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.checks.marks_freeswitch_offer_ice_lite, true);
  assert.equal(summary.checks.clears_repeated_pcmu_marker, true);
});
