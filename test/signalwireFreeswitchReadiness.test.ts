import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.equal(payload.trunkMode, "registration");
    assert.doesNotMatch(stdout, /example\.sip\.signalwire\.com/);

    const gateway = await readFile(path.join(tempDir, "sip_profiles/external/signalwire.xml"), "utf8");
    const dialplan = await readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8");
    assert.match(gateway, /<gateway name="signalwire">/);
    assert.match(gateway, /example-rendered-sip-password/);
    assert.match(gateway, /example\.sip\.signalwire\.com/);
    assert.match(dialplan, /agentic_contact_center_signalwire_pstn/);
    assert.match(dialplan, /acc_route=signalwire_live/);
    assert.match(dialplan, /\\\+?12029687351|2029687351/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness redacts normalized SIP hosts from fs_cli proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "SIP-IP 192.168.50.4" "RTP-IP 10.0.0.8" "Ext-SIP-IP fd00::1234" ;;
  "sofia status gateway signalwire") printf '%s\\n' "gateway signalwire REGED example.sip.signalwire.com" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351)$"><action application="set" data="acc_route=signalwire_live"/></condition></extension>' ;;
  *) printf '%s\\n' "0 total registrations" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--fs-cli-bin",
      fsCliBin,
      "--manifest",
      path.join(tempDir, "readiness.json"),
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.doesNotMatch(stdout, /example\.sip\.signalwire\.com/);
    assert.doesNotMatch(stdout, /192\.168\.50\.4|10\.0\.0\.8|fd00::1234/);
    assert.doesNotMatch(stdout, /12029687351|2029687351/);
    assert.match(stdout, /\[redacted-address\]/);
    assert.match(stdout, /gateway signalwire REGED \[redacted\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness supports IP-auth trunks without REGED", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><action application="set" data="acc_route=signalwire_live"/></extension>' ;;
  *) printf '%s\\n' "0 total registrations" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--fs-cli-bin",
      fsCliBin,
      "--manifest",
      path.join(tempDir, "readiness.json"),
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_TRUNK_MODE: "ip-auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.trunkMode, "ip_auth");
    assert.deepEqual(payload.requiredEnv, ["SIGNALWIRE_FROM_NUMBER", "FREESWITCH_PUBLIC_SIP_HOST"]);
    assert.deepEqual(payload.missingEnv, []);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
    assert.deepEqual(
      payload.freeswitchCli.map((entry: { command: string }) => entry.command),
      [
        "fs_cli -x 'sofia status profile external'",
        "fs_cli -x 'show registrations'",
        "fs_cli -x 'xml_locate dialplan extension name agentic_contact_center_signalwire_pstn'",
      ],
    );
    assert.ok(!payload.blockers.includes("signalwire_gateway_status_not_proven"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness renders only the inbound dialplan for IP-auth trunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));

  try {
    const staleGatewayPath = path.join(tempDir, "sip_profiles/external/signalwire.xml");
    await mkdir(path.dirname(staleGatewayPath), { recursive: true });
    await writeFile(staleGatewayPath, "<gateway name=\"stale-registration\"/>", "utf8");

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.generatedConfig.gatewayPath, null);
    assert.match(payload.generatedConfig.dialplanPath, /signalwire_inbound\.xml$/);
    await assert.rejects(readFile(staleGatewayPath, "utf8"));
    assert.match(
      await readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8"),
      /agentic_contact_center_signalwire_pstn/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects an inactive inbound dialplan", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' "Can't find extension." ;;
  *) printf '%s\\n' "0 total registrations" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/signalwire-freeswitch-readiness.mjs",
        "--fs-cli-bin",
        fsCliBin,
        "--manifest",
        path.join(tempDir, "readiness.json"),
      ], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          SIGNALWIRE_TRUNK_MODE: "ip_auth",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const profileOutput of ["Invalid Profile!", "external profile DOWN"]) {
  test(`SignalWire FreeSWITCH readiness rejects IP-auth profile output: ${profileOutput}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
    const fsCliBin = path.join(tempDir, "fs_cli");

    try {
      await writeFile(fsCliBin, `#!/bin/sh\nprintf '%s\\n' "${profileOutput}"\n`, "utf8");
      await chmod(fsCliBin, 0o700);

      await assert.rejects(
        execFileAsync(process.execPath, [
          "scripts/signalwire-freeswitch-readiness.mjs",
          "--fs-cli-bin",
          fsCliBin,
          "--manifest",
          path.join(tempDir, "readiness.json"),
        ], {
          cwd: repoRoot,
          env: {
            PATH: process.env.PATH ?? "",
            SIGNALWIRE_TRUNK_MODE: "ip_auth",
            SIGNALWIRE_FROM_NUMBER: "+12029687351",
            FREESWITCH_PUBLIC_SIP_HOST: "sip-public-host.example.test",
          },
          encoding: "utf8",
        }),
        (error: unknown) => {
          const result = error as { stdout?: string; code?: number };
          assert.equal(result.code, 2);
          const payload = JSON.parse(result.stdout ?? "{}");
          assert.equal(payload.manualCallReady, false);
          assert.equal(payload.status, "blocked");
          assert.ok(payload.blockers.includes("freeswitch_external_profile_not_running"));
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
