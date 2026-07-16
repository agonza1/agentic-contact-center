import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
    sdpTarget: { host: string; port: number };
    packetCount: number;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.authorizationReady, true);
  assert.deepEqual(summary.sdpTarget, { host: "127.0.0.1", port: 29790 });
  assert.ok(summary.packetCount > 0);
});
