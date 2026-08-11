import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..", "..");
const artifactsRoot = path.join(repoRoot, "artifacts");
const signalWireProviderIngressCidrs = "54.172.60.0/30";
let reachabilityProofPath = "";

async function mkArtifactTempDir(prefix: string) {
  await mkdir(artifactsRoot, { recursive: true });
  return mkdtemp(path.join(artifactsRoot, prefix));
}

async function writeExternalSipReachabilityProof(
  tempDir: string,
  host = "8.8.8.8",
  port = 5060,
  overrides: Record<string, unknown> = {},
) {
  const proofPath = path.join(tempDir, "external-sip-reachability.json");
  await writeFile(
    proofPath,
    JSON.stringify({
      source: "external-provider-probe",
      targetHost: host,
      targetPort: port,
      transport: "udp",
      reachable: true,
      result: "sip_options_response",
      sipResponseCode: 401,
      checkedAt: new Date().toISOString(),
      ...overrides,
    }),
    "utf8",
  );
  return proofPath;
}

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

test("SignalWire FreeSWITCH readiness rejects digitless SignalWire numbers before rendering", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
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
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.generatedConfig, null);
        assert.ok(payload.blockers.includes("invalid_signalwire_from_number"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const invalidDid of ["abc123", "1"]) {
  test(`SignalWire FreeSWITCH readiness rejects malformed SignalWire number before rendering: ${invalidDid}`, async () => {
    const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");

    try {
      await assert.rejects(
        execFileAsync(process.execPath, [
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
            SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
            SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
            SIGNALWIRE_FROM_NUMBER: invalidDid,
            FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
            SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
            SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
          },
          encoding: "utf8",
        }),
        (error: unknown) => {
          const result = error as { stdout?: string; code?: number };
          assert.equal(result.code, 2);
          const payload = JSON.parse(result.stdout ?? "{}");
          assert.equal(payload.generatedConfig, null);
          assert.ok(payload.blockers.includes("invalid_signalwire_from_number"));
          return true;
        },
      );
      await assert.rejects(readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("SignalWire FreeSWITCH readiness renders ignored config without leaking secrets to stdout", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");
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
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com:443",
        SIGNALWIRE_PROJECT_ID: projectId,
        SIGNALWIRE_TOKEN: token,
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: renderedPassword,
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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
    assert.equal(payload.sourceRestriction.type, "freeswitch_acl");
    assert.equal(payload.sourceRestriction.aclName, "signalwire_trunk");
    assert.equal(payload.sourceRestriction.activeAclProven, false);
    assert.doesNotMatch(payload.sourceRestriction.probeIp, /54\.172\.60\.0/);
    assert.doesNotMatch(stdout, /example\.sip\.signalwire\.com/);

    const gateway = await readFile(path.join(tempDir, "sip_profiles/external/signalwire.xml"), "utf8");
    const dialplan = await readFile(path.join(tempDir, "dialplan/public/signalwire_inbound.xml"), "utf8");
    assert.match(gateway, /<gateway name="signalwire">/);
    assert.match(gateway, /example-rendered-sip-password/);
    assert.match(gateway, /example\.sip\.signalwire\.com/);
    assert.match(dialplan, /agentic_contact_center_signalwire_pstn/);
    assert.match(dialplan, /\$\{acl\(\$\{network_addr\} signalwire_trunk\)\}/);
    assert.match(dialplan, /acc_route=signalwire_live/);
    assert.match(dialplan, /acc_destination_number=8600/);
    assert.match(dialplan, /acc_conversation_mode=openai_llm/);
    assert.match(dialplan, /acc_media_bridge=pipecat_verto_agent_leg/);
    assert.match(dialplan, /verto_contact\(acc-pipecat@/);
    assert.match(dialplan, /sip_h_X-ACC-Telephony-Mode=signalwire_live/);
    assert.match(dialplan, /\\\+?12029687351|2029687351/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness does not report rendered status without rendering", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--skip-fs-cli",
      "--manifest",
      path.join(tempDir, "readiness.json"),
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
        SIGNALWIRE_SIP_REALM: "EXAMPLE.SIP.SIGNALWIRE.COM",
        SIGNALWIRE_SIP_PROXY: "EXAMPLE.SIP.SIGNALWIRE.COM",
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.generatedConfig, null);
    assert.equal(payload.manualCallReady, false);
    assert.equal(payload.status, "config_validated_pending_render_or_freeswitch_cli");
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
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" "SIP-IP 192.168.50.4" "RTP-IP 10.0.0.8" "Ext-SIP-IP fd00::1234" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "sofia status gateway signalwire") printf '%s\\n' "State REGED" "Realm example.sip.signalwire.com" "Proxy example.sip.signalwire.com" "Username acc-sip-user" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    const manifest = await readFile(path.join(tempDir, "readiness.json"), "utf8");
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.deepEqual(payload.gatewayRegistration, {
      registered: true,
      realmMatches: true,
      proxyMatches: true,
      usernameMatches: true,
    });
    assert.deepEqual(payload.vertoRegistration, {
      expectedContacts: ["acc-pipecat@example.test"],
      registered: true,
    });
    assert.doesNotMatch(stdout, /example\.sip\.signalwire\.com/i);
    assert.doesNotMatch(manifest, /example\.sip\.signalwire\.com/i);
    assert.doesNotMatch(stdout, /192\.168\.50\.4|10\.0\.0\.8|fd00::1234/);
    assert.doesNotMatch(stdout, /12029687351|2029687351/);
    assert.match(stdout, /\[redacted-address\]/);
    assert.match(stdout, /Realm:? \[redacted\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness redacts dynamically discovered private Verto domains", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@pbx.private.lan)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@pbx.private.lan REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const manifest = await readFile(path.join(tempDir, "readiness.json"), "utf8");
    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
    assert.deepEqual(payload.vertoRegistration.expectedContacts, ["acc-pipecat@[redacted]"]);
    assert.doesNotMatch(stdout, /pbx\.private\.lan/i);
    assert.doesNotMatch(manifest, /pbx\.private\.lan/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects stale Verto agent registrations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" "SIP-IP 192.168.50.4" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "sofia status gateway signalwire") printf '%s\\n' "State: REGED" "Realm: example.sip.signalwire.com" "Proxy: example.sip.signalwire.com" "Username: acc-sip-user" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@stale.example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "2001:4860:4860::8888");

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
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("verto_agent_contact_not_proven"));
        assert.deepEqual(payload.vertoRegistration, {
          expectedContacts: ["acc-pipecat@example.test"],
          registered: false,
        });
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects stale registration gateways", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" "SIP-IP 192.168.50.4" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "sofia status gateway signalwire") printf '%s\\n' "State: REGED" "Realm: stale.sip.signalwire.com" "Proxy: stale.sip.signalwire.com" "Username: stale-sip-user" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_gateway_identity_mismatch"));
        assert.deepEqual(payload.gatewayRegistration, {
          registered: true,
          realmMatches: false,
          proxyMatches: false,
          usernameMatches: false,
        });
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires the gateway authentication username", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "sofia status gateway signalwire") printf '%s\\n' "State REGED" "Realm example.sip.signalwire.com" "Proxy example.sip.signalwire.com" "Auth-Username wrong-sip-user" "From-User acc-sip-user" "Extension acc-sip-user" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.gatewayRegistration.usernameMatches, false);
        assert.ok(payload.blockers.includes("signalwire_gateway_identity_mismatch"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects registration trunks without public endpoint proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 192.168.50.4" "SIP-Port 5060" ;;
  "sofia status gateway signalwire") printf '%s\\n' "State REGED" "Realm example.sip.signalwire.com" "Proxy example.sip.signalwire.com" "Username acc-sip-user" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness redacts unbracketed IPv6 values from fs_cli proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED network_ip=fd00::dead:beef" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.doesNotMatch(stdout, /fd00::dead:beef/);
    assert.match(stdout, /\[redacted-address\]/);
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
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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
    assert.equal(payload.sourceRestriction.activeAclProven, true);
    assert.equal(payload.sourceRestriction.activeAclRejectsNonProvider, true);
    assert.deepEqual(
      payload.freeswitchCli.map((entry: { command: string }) => entry.command),
      [
        "fs_cli -x 'sofia status profile external'",
        "fs_cli -x 'xml_locate configuration list name signalwire_trunk'",
        "fs_cli -x 'acl [redacted] signalwire_trunk'",
        "fs_cli -x 'acl [redacted] signalwire_trunk'",
        "fs_cli -x 'show registrations'",
        "fs_cli -x 'xml_locate dialplan extension name agentic_contact_center_signalwire_pstn'",
      ],
    );
    assert.ok(!payload.blockers.includes("signalwire_gateway_status_not_proven"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects sibling bridges outside the approved ACL condition", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/></condition><condition field="caller_id_number" expression=".*"><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness rejects partial ACL field expansions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}-disabled" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects aggregated actions from mutually exclusive ACL branches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><condition field="caller_id_number" expression="^blocked$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/></condition><condition field="caller_id_number" expression="^allowed$"><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness rejects bridge paths behind unproven nested predicates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><condition field="caller_id_number" expression="^15551234567$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires the DID condition as a direct extension child", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="caller_id_number" expression="^15551234567$"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects route metadata after the accepted bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects terminal actions before the accepted bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="hangup" data="NORMAL_CLEARING"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects park before the accepted bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="park"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires PCMU on the Verto bridge action", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU}sofia/external/loopback@example.test"/><action application="bridge" data="verto_contact(acc-pipecat@example.test)"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness rejects malformed PCMU bridge assignments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMUCORRUPT,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness keeps manual call closed without external SIP reachability proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);
    const reachabilityProofPath = "";

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.missingEnv.includes("SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH"));
        assert.ok(payload.blockers.includes("freeswitch_external_sip_reachability_not_proven"));
        assert.equal(payload.endpoint.externalSipReachability.proven, false);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects generic reachability proof without SIP exchange evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5060, {
      result: "reachable",
      sipResponseCode: undefined,
    });

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("invalid_freeswitch_external_sip_reachability_proof"));
        assert.equal(payload.endpoint.externalSipReachability.sipResponseCode, null);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects reachability proof without declared SIP transport", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5060, {
      transport: undefined,
    });

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("invalid_freeswitch_external_sip_reachability_proof"));
        assert.equal(payload.endpoint.externalSipReachability.transport, null);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects reachability proof for the wrong SIP transport", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "sofia status gateway signalwire") printf '%s\\n' "State REGED" "Realm example.sip.signalwire.com" "Proxy example.sip.signalwire.com" "Username acc-sip-user" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5060, {
      transport: "tcp",
    });

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
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("invalid_freeswitch_external_sip_reachability_proof"));
        assert.equal(payload.endpoint.externalSipReachability.transport, "tcp");
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects future-dated reachability proof", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5060, {
      checkedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("future_dated_freeswitch_external_sip_reachability_proof"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects a broad source ACL that allows non-provider sources", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "true" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="0.0.0.0/0"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.sourceRestriction.activeAclProven, false);
        assert.equal(payload.sourceRestriction.activeAclRejectsNonProvider, false);
        assert.ok(payload.blockers.includes("signalwire_source_acl_too_permissive"));
        assert.doesNotMatch(result.stdout ?? "", /54\.172\.60\.0|8\.8\.8\.8/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects non-provider ACL allow entries even when the canary is denied", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/><node type="allow" cidr="0.0.0.0/0"/></list>' ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.sourceRestriction.activeAclProven, false);
        assert.equal(payload.sourceRestriction.activeAclRejectsNonProvider, false);
        assert.equal(payload.sourceRestriction.activeAclAllowSetProviderOnly, false);
        assert.ok(payload.blockers.includes("signalwire_source_acl_too_permissive"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects non-CIDR ACL allow nodes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/><node type="allow" domain="example.com"/></list>' ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.sourceRestriction.activeAclAllowSetProviderOnly, false);
        assert.ok(payload.blockers.includes("signalwire_source_acl_too_permissive"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires an ACL probe before manual call readiness", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      "#!/bin/sh\nprintf '%s\\n' 'external profile RUNNING' 'Ext-SIP-IP 8.8.8.8'\n",
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.missingEnv.includes("SIGNALWIRE_SOURCE_IP_PROBE"));
        assert.ok(payload.blockers.includes("signalwire_source_acl_probe_missing"));
        assert.deepEqual(payload.freeswitchCli, []);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects a source IP outside the active ACL", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.sourceRestriction.activeAclProven, false);
        assert.ok(payload.blockers.includes("signalwire_source_acl_not_proven"));
        assert.doesNotMatch(result.stdout ?? "", /54\.172\.60\.0/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const unroutableProbeIp of ["10.0.0.5", "192.0.2.10", "2001:db8::10", "::ffff:192.0.2.10"]) {
  test(`SignalWire FreeSWITCH readiness rejects non-routable ACL probe IP: ${unroutableProbeIp}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
    const fsCliBin = path.join(tempDir, "fs_cli");

    try {
      await writeFile(
        fsCliBin,
        "#!/bin/sh\nprintf '%s\\n' 'unexpected fs_cli invocation'\n",
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
            FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
            SIGNALWIRE_SOURCE_IP_PROBE: unroutableProbeIp,
          },
          encoding: "utf8",
        }),
        (error: unknown) => {
          const result = error as { stdout?: string; code?: number };
          assert.equal(result.code, 2);
          const payload = JSON.parse(result.stdout ?? "{}");
          assert.equal(payload.manualCallReady, false);
          assert.ok(payload.blockers.includes("invalid_signalwire_source_ip_probe"));
          assert.deepEqual(payload.freeswitchCli, []);
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("SignalWire FreeSWITCH readiness rejects public ACL probes outside provider-owned ingress ranges", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      "#!/bin/sh\nprintf '%s\\n' 'unexpected fs_cli invocation'\n",
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "8.8.8.8",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.equal(payload.sourceRestriction.providerOwnedProbe, false);
        assert.ok(payload.blockers.includes("signalwire_source_probe_not_provider_owned"));
        assert.deepEqual(payload.freeswitchCli, []);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects malformed provider ingress CIDRs before fs_cli", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      "#!/bin/sh\nprintf '%s\\n' 'unexpected fs_cli invocation'\n",
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: "54.172.60.0/30,54.172.60.0/99",
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("invalid_signalwire_provider_ingress_cidrs"));
        assert.deepEqual(payload.freeswitchCli, []);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness preserves bracketed IPv6 endpoint hosts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 2001:4860:4860::8888" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(
      tempDir,
      "2001:4860:4860:0000:0000:0000:0000:8888",
    );

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "[2001:4860:4860::8888]:5060",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.manualCallReady, true);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness matches equivalent IPv6 endpoint notation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 2001:4860:4860:0000:0000:0000:0000:8888" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "2001:4860:4860::8888");

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "[2001:4860:4860::8888]:5060",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness renders only the inbound dialplan for IP-auth trunks", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");

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
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness rejects render output outside ignored artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
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
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.generatedConfig, null);
        assert.ok(payload.blockers.includes("unsafe_freeswitch_output_dir"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(tempDir, "sip_profiles/external/signalwire.xml"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects symlinked artifact output dirs", async () => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-outside-"));
  const symlinkPath = path.join(artifactsRoot, `acc-signalwire-link-${Date.now()}`);

  try {
    await mkdir(artifactsRoot, { recursive: true });
    await symlink(outsideDir, symlinkPath, "dir");

    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/signalwire-freeswitch-readiness.mjs",
        "--render",
        "--skip-fs-cli",
        "--out-dir",
        path.join(symlinkPath, "conf"),
        "--manifest",
        path.join(outsideDir, "readiness.json"),
      ], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.generatedConfig, null);
        assert.ok(payload.blockers.includes("unsafe_freeswitch_output_dir"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(outsideDir, "conf/sip_profiles/external/signalwire.xml"), "utf8"));
  } finally {
    await rm(symlinkPath, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects symlinked generated config children", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-outside-"));

  try {
    await mkdir(path.join(tempDir, "sip_profiles"), { recursive: true });
    await symlink(outsideDir, path.join(tempDir, "sip_profiles/external"), "dir");

    await assert.rejects(
      execFileAsync(process.execPath, [
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
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.generatedConfig, null);
        assert.ok(payload.blockers.includes("unsafe_freeswitch_output_dir"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(outsideDir, "signalwire.xml"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness replaces symlinked manifests without touching the target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const manifestTarget = path.join(tempDir, "linked-readiness-target.json");
  const manifestPath = path.join(tempDir, "readiness.json");

  try {
    await writeFile(manifestTarget, "linked-manifest-secret", { mode: 0o600 });
    await symlink(manifestTarget, manifestPath);

    await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--skip-fs-cli",
      "--manifest",
      manifestPath,
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    assert.equal(await readFile(manifestTarget, "utf8"), "linked-manifest-secret");
    assert.equal((await lstat(manifestPath)).isSymbolicLink(), false);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness replaces hard-linked manifests without touching sibling links", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const manifestTarget = path.join(tempDir, "linked-readiness-target.json");
  const manifestPath = path.join(tempDir, "readiness.json");

  try {
    await writeFile(manifestTarget, "linked-manifest-secret", { mode: 0o600 });
    await link(manifestTarget, manifestPath);

    await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--skip-fs-cli",
      "--manifest",
      manifestPath,
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    assert.equal(await readFile(manifestTarget, "utf8"), "linked-manifest-secret");
    assert.equal((await stat(manifestPath)).nlink, 1);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects manifest paths below symlinked directories", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const manifestTargetDir = path.join(tempDir, "linked-manifest-target");
  const manifestLinkDir = path.join(tempDir, "linked-manifest-dir");
  const manifestPath = path.join(manifestLinkDir, "readiness.json");

  try {
    await mkdir(manifestTargetDir, { recursive: true });
    await symlink(manifestTargetDir, manifestLinkDir, "dir");
    let payload: { manualCallReady?: boolean; blockers?: string[] } = {};

    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/signalwire-freeswitch-readiness.mjs",
        "--skip-fs-cli",
        "--manifest",
        manifestPath,
      ], {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? "",
          SIGNALWIRE_SPACE_URL: "https://example.signalwire.com",
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers?.includes("unsafe_freeswitch_manifest_path"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(manifestTargetDir, "readiness.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness restores credential file permissions when rerendering", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");
  const gatewayPath = path.join(tempDir, "sip_profiles/external/signalwire.xml");

  try {
    await mkdir(path.dirname(gatewayPath), { recursive: true });
    await writeFile(gatewayPath, "<gateway name=\"permissive\"/>", { mode: 0o644 });
    await chmod(gatewayPath, 0o644);

    await execFileAsync(process.execPath, [
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
        SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
        SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    assert.equal((await stat(gatewayPath)).mode & 0o777, 0o600);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects hard-linked generated credential files", async () => {
  const tempDir = await mkArtifactTempDir("acc-signalwire-fs-");
  const gatewayPath = path.join(tempDir, "sip_profiles/external/signalwire.xml");
  const linkedPath = path.join(tempDir, "linked-signalwire.xml");

  try {
    await mkdir(path.dirname(gatewayPath), { recursive: true });
    await writeFile(gatewayPath, "<gateway name=\"linked-secret\"/>", { mode: 0o600 });
    await link(gatewayPath, linkedPath);

    await assert.rejects(
      execFileAsync(process.execPath, [
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
          SIGNALWIRE_SIP_USERNAME: "acc-sip-user",
          SIGNALWIRE_SIP_PASSWORD: "example-rendered-sip-password",
          SIGNALWIRE_FROM_NUMBER: "+12029687351",
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const result = error as { stdout?: string; code?: number };
        assert.equal(result.code, 2);
        const payload = JSON.parse(result.stdout ?? "{}");
        assert.equal(payload.generatedConfig, null);
        assert.ok(payload.blockers.includes("unsafe_freeswitch_output_link"));
        return true;
      },
    );
    assert.equal(await readFile(linkedPath, "utf8"), "<gateway name=\"linked-secret\"/>");
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
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' "Can't find extension." ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness rejects a stale inbound DID", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?13125550100)$"><action application="set" data="acc_route=signalwire_live"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects semantic escapes in DID alternatives", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects broad active DID regex behavior", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression=".*"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects extra accepted DID values", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc|sales)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects active dialplan without Verto agent contact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}verto_contact(acc-pipecat@example.test)"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects bridge targets with trailing non-Verto destinations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)},sofia/external/fallback@example.test"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires acc_route on the bridged Verto leg", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:acc_route=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects malformed destination export suffixes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=86000"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects route metadata overrides before the accepted bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=scripted"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("signalwire_inbound_dialplan_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects an inactive Verto agent registration", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "0 total registrations" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("verto_agent_contact_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness matches registration to the guarded PCMU bridge contact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@dead.example)}"/></condition><condition field="caller_id_number" expression=".*"><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@live.example)}"/></condition></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@live.example REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.deepEqual(payload.vertoRegistration.expectedContacts, ["acc-pipecat@dead.example"]);
        assert.ok(payload.blockers.includes("verto_agent_contact_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness rejects an unadvertised IP-auth endpoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      "#!/bin/sh\nprintf '%s\\n' 'external profile RUNNING' 'Ext-SIP-IP 8.8.4.4'\n",
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness requires the public endpoint in Ext-SIP-IP", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "SIP-IP 8.8.8.8" "Ext-SIP-IP 10.0.0.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness validates default public SIP port", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5070" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness validates non-default public SIP port", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5070);

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
          FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8:5070",
          SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
          SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
          SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
        },
        encoding: "utf8",
      }),
      (error: unknown) => {
        const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        assert.equal(payload.manualCallReady, false);
        assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness accepts matching non-default public SIP port", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" "BIND-URL sip:mod_sofia@8.8.8.8:5070;maddr=8.8.8.8;transport=udp" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "8.8.8.8", 5070);

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8:5070",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness accepts globally routable 192.0.0.0/16 addresses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 192.0.8.1" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    const privateSource = "external-probe 10.0.0.4 private-pbx.lan";
    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "192.0.8.1", 5060, {
      source: privateSource,
    });
    const manifestPath = path.join(tempDir, "readiness.json");

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/signalwire-freeswitch-readiness.mjs",
      "--fs-cli-bin",
      fsCliBin,
      "--manifest",
      manifestPath,
    ], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "192.0.8.1",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
    assert.equal(payload.endpoint.externalSipReachability.proven, true);
    assert.equal(payload.endpoint.externalSipReachability.source, "[redacted]");
    assert.doesNotMatch(stdout, /10\.0\.0\.4|private-pbx\.lan/);
    assert.doesNotMatch(await readFile(manifestPath, "utf8"), /10\.0\.0\.4|private-pbx\.lan/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SignalWire FreeSWITCH readiness accepts globally routable 2001::/23 exceptions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP 2001:3::1" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir, "2001:3::1");

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "[2001:3::1]:5060",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
    assert.equal(payload.endpoint.externalSipReachability.proven, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const unroutableHost of ["192.0.2.10", "198.51.100.7", "203.0.113.9", "2001:db8::10", "2001:2::1", "3fff::10", "5f00::10", "::ffff:192.0.2.10"]) {
  test(`SignalWire FreeSWITCH readiness rejects non-routable IP-auth endpoint: ${unroutableHost}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
    const fsCliBin = path.join(tempDir, "fs_cli");

    try {
      await writeFile(
        fsCliBin,
        `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "external profile RUNNING" "Ext-SIP-IP ${unroutableHost}" "SIP-Port 5060" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
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
            FREESWITCH_PUBLIC_SIP_HOST: unroutableHost,
            SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
            SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
          },
          encoding: "utf8",
        }),
        (error: unknown) => {
          const payload = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
          assert.equal(payload.manualCallReady, false);
          assert.ok(payload.blockers.includes("freeswitch_public_sip_endpoint_not_proven"));
          return true;
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

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
            FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
            SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
            SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
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

test("SignalWire FreeSWITCH readiness accepts running profiles with failure counters", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "acc-signalwire-fs-"));
  const fsCliBin = path.join(tempDir, "fs_cli");

  try {
    await writeFile(
      fsCliBin,
      `#!/bin/sh
case "$2" in
  "sofia status profile external") printf '%s\\n' "Name external" "State RUNNING" "Ext-SIP-IP 8.8.8.8" "SIP-Port 5060" "FAILED-CALLS-IN 3" "FAILED-CALLS-OUT 5" ;;
  "acl 54.172.60.0 signalwire_trunk") printf '%s\\n' "true" ;;
  "acl 8.8.8.8 signalwire_trunk") printf '%s\\n' "false" ;;
  "xml_locate configuration list name signalwire_trunk") printf '%s\\n' '<list name="signalwire_trunk" default="deny"><node type="allow" cidr="54.172.60.0/30"/></list>' ;;
  "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn") printf '%s\\n' '<extension name="agentic_contact_center_signalwire_pstn"><condition field="destination_number" expression="^(\\+?12029687351|2029687351|8600|acc)$"><condition field="\${acl(\${network_addr} signalwire_trunk)}" expression="^true$"><action application="set" data="acc_route=signalwire_live"/><action application="set" data="acc_destination_number=8600"/><action application="set" data="acc_conversation_mode=openai_llm"/><action application="set" data="acc_media_bridge=pipecat_verto_agent_leg"/><action application="export" data="nolocal:sip_h_X-ACC-Telephony-Mode=signalwire_live"/><action application="export" data="nolocal:sip_h_X-ACC-Destination=8600"/><action application="export" data="nolocal:sip_h_X-ACC-Conversation-Mode=openai_llm"/><action application="bridge" data="{absolute_codec_string=PCMU,acc_route=signalwire_live}\${verto_contact(acc-pipecat@example.test)}"/></condition></extension>' ;;
  *) printf '%s\\n' "acc-pipecat@example.test REGED" ;;
esac
`,
      "utf8",
    );
    await chmod(fsCliBin, 0o700);

    reachabilityProofPath = await writeExternalSipReachabilityProof(tempDir);

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
        SIGNALWIRE_TRUNK_MODE: "ip_auth",
        SIGNALWIRE_FROM_NUMBER: "+12029687351",
        FREESWITCH_PUBLIC_SIP_HOST: "8.8.8.8",
        SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
        SIGNALWIRE_PROVIDER_INGRESS_CIDRS: signalWireProviderIngressCidrs,
        SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: reachabilityProofPath,
      },
      encoding: "utf8",
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "ready_for_manual_pstn_call");
    assert.equal(payload.manualCallReady, true);
    assert.ok(!payload.blockers.includes("freeswitch_external_profile_not_running"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
