import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..", "..");

test("SignalWire FreeSWITCH readiness fails closed when required env is missing", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/signalwire-freeswitch-readiness.mjs", "--skip-fs-cli"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    }),
    (error: unknown) => {
      const result = error as { stdout?: string; code?: number };
      assert.equal(result.code, 2);
      const payload = JSON.parse(result.stdout ?? "{}");
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "blocked");
      assert.ok(payload.missingEnv.includes("SIGNALWIRE_SIP_PASSWORD"));
      assert.ok(payload.blockers.includes("missing_signalwire_or_freeswitch_env"));
      return true;
    },
  );
});

test("SignalWire FreeSWITCH readiness renders ignored config without leaking secrets to stdout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const renderedPassword = "example-rendered-sip-password";
  const projectId = "example-project-id";
  const token = "example-api-token";

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--render",
      "--skip-fs-cli",
      "--out-dir",
      tempDir,
      "--manifest",
      path.join(tempDir, "readiness.json"),
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
        SIGNALWIRE_PROJECT_ID: projectId,
        SIGNALWIRE_TOKEN: token,
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: renderedPassword,
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
      },
      encoding: "utf8",
    });

    assert.doesNotMatch(stdout, new RegExp(renderedPassword));
    assert.doesNotMatch(stdout, new RegExp(projectId));
    assert.doesNotMatch(stdout, new RegExp(token));

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "config_rendered_pending_freeswitch_cli");
    assert.equal(payload.manualCallReady, false);
    assert.equal(payload.generatedConfig.gitignored, true);

    const gateway = await readFile(path.join(tempDir, "sip_profiles/external/signalwire.xml"), "utf8");
    const dialplan = await readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8");
    assert.match(gateway, /<gateway name="signalwire">/);
    assert.match(gateway, /example-rendered-sip-password/);
    assert.match(dialplan, /agentic_contact_center_signalwire_pstn/);
    assert.match(dialplan, /acc_route=signalwire_live/);
    assert.match(dialplan, /\\\+?12029687351|2029687351/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
