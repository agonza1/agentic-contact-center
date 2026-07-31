#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const args = process.argv.slice(2);
const specialUseIpv6 = new BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  specialUseIpv6.addSubnet(address, prefix, "ipv6");
}

const COMMON_REQUIRED_ENV = [
  "SIGNALWIRE_FROM_NUMBER",
  "FREESWITCH_PUBLIC_SIP_HOST",
];
const REGISTRATION_REQUIRED_ENV = [
  "SIGNALWIRE_SPACE_URL",
  "SIGNALWIRE_SIP_USERNAME",
  "SIGNALWIRE_SIP_PASSWORD",
];
const ALL_ENV = [...COMMON_REQUIRED_ENV, ...REGISTRATION_REQUIRED_ENV];

function hasFlag(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSpaceHost(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host;
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function signalwireSipHostFromSpaceUrl(value) {
  const host = normalizeSpaceHost(value).toLowerCase();
  if (!host) return "";
  if (host.endsWith(".sip.signalwire.com")) return host;
  if (host.endsWith(".signalwire.com")) {
    return `${host.slice(0, -".signalwire.com".length)}.sip.signalwire.com`;
  }
  return host;
}

function redact(value) {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 6) return "[redacted]";
  return `${text.slice(0, 2)}...[redacted]...${text.slice(-2)}`;
}

function buildRedactor(values) {
  const secrets = values.filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) => {
    let redacted = text;
    for (const secret of secrets) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted
      .replace(
        /^(\s*(?:ext-)?(?:sip|rtp)-ip(?:\s*[:=]\s*|\s+))\S+/gim,
        "$1[redacted-address]",
      )
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-address]")
      .replace(/\[[0-9a-f:]+\]/gi, "[redacted-address]");
  };
}

function xmlEscape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function regexpEscape(value) {
  return clean(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function didPattern(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "NO_SIGNALWIRE_DID_CONFIGURED";
  const withOptionalPlus = `\\+?${regexpEscape(digits)}`;
  const withoutCountry = digits.length === 11 && digits.startsWith("1") ? regexpEscape(digits.slice(1)) : "";
  return [withOptionalPlus, withoutCountry].filter(Boolean).join("|");
}

function isExternalProfileRunning(entry) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/\b(?:DOWN|FAILED|STOPPED)\b|invalid\s+profile|not\s+running/i.test(output)) return false;
  return /\bRUNNING\b/i.test(output);
}

function isInboundDialplanActive(entry, expectedDidPattern) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/can't\s+find|not\s+found|invalid/i.test(output)) return false;
  return /agentic_contact_center_signalwire_pstn/i.test(output)
    && /acc_route=signalwire_live/i.test(output)
    && /acc_destination_number=8600/i.test(output)
    && /acc_conversation_mode=openai_llm/i.test(output)
    && /(?:sip_h_X-ACC-Telephony-Mode|X-ACC-Telephony-Mode)=signalwire_live/i.test(output)
    && /(?:sip_h_X-ACC-Destination|X-ACC-Destination)=8600/i.test(output)
    && /(?:sip_h_X-ACC-Conversation-Mode|X-ACC-Conversation-Mode)=openai_llm/i.test(output)
    && /acc_media_bridge=pipecat_verto_agent_leg/i.test(output)
    && /verto_contact\(acc-pipecat@/i.test(output)
    && output.includes(expectedDidPattern);
}

function isPublicIpAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || a === 255);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4) return isPublicIpAddress(mappedIpv4[1]);
    return !specialUseIpv6.check(normalized, "ipv6");
  }
  return false;
}

function normalizeSipEndpointHost(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `sip://${raw}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return removeEndpointPort(raw);
  }
}

async function resolvePublicEndpointAddresses(value) {
  const host = normalizeSipEndpointHost(value);
  if (!host) return [];
  if (isIP(host)) return isPublicIpAddress(host) ? [host] : [];
  try {
    const addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    return addresses.filter(isPublicIpAddress);
  } catch {
    return [];
  }
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function hasSymlinkedAncestor(parent, child) {
  if (!isPathInside(parent, child)) return true;
  try {
    if ((await lstat(parent)).isSymbolicLink()) return true;
  } catch (error) {
    if (!(error && error.code === "ENOENT")) throw error;
  }
  const relativeParts = path.relative(parent, child).split(path.sep).filter(Boolean);
  let current = parent;
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function removeEndpointPort(value) {
  const raw = clean(value);
  if (!raw) return "";
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount === 1) return raw.replace(/:\d+$/, "");
  return raw;
}

function isIpAuthEndpointAdvertised(entry, expectedAddresses) {
  if (!entry || expectedAddresses.length === 0) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  const advertised = [...output.matchAll(/^\s*(?:ext-)?sip-ip(?:\s*[:=]\s*|\s+)(\S+)/gim)]
    .map((match) => removeEndpointPort(match[1]));
  return expectedAddresses.some((address) => advertised.includes(address));
}

function isVertoAgentContactRegistered(entry) {
  if (!entry) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  if (/\b0\s+total\s+registrations\b/i.test(output)) return false;
  return /\bacc-pipecat@/i.test(output);
}

async function renderTemplate(templatePath, outputPath, replacements) {
  let text = await readFile(templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`__${key}__`, value);
  }
  const outputDirname = path.dirname(outputPath);
  await mkdir(outputDirname, { recursive: true });
  const tempPath = path.join(outputDirname, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, text, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, outputPath);
  await chmod(outputPath, 0o600);
  return outputPath;
}

async function safeArtifactOutputPath(outputPath) {
  return isPathInside(artifactsRoot, outputPath)
    && !(await hasSymlinkedAncestor(artifactsRoot, outputPath));
}

async function isMultiplyLinkedDestination(outputPath) {
  try {
    return (await lstat(outputPath)).nlink > 1;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function runFsCli(command, redactor) {
  const fsCliBin = argValue("--fs-cli-bin", process.env.FS_CLI_BIN || "fs_cli");
  const { stdout, stderr } = await execFileAsync(fsCliBin, ["-x", command], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: Number(argValue("--fs-cli-timeout-ms", "5000")),
    maxBuffer: 1024 * 1024,
  });
  return {
    proof: {
      command: `fs_cli -x '${command}'`,
      stdout: redactor(stdout.trim()),
      stderr: redactor(stderr.trim()),
    },
    raw: {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    },
  };
}

const trunkMode = clean(process.env.SIGNALWIRE_TRUNK_MODE || "registration").toLowerCase().replace(/-/g, "_");
const requiredEnv = trunkMode === "registration"
  ? [...COMMON_REQUIRED_ENV, ...REGISTRATION_REQUIRED_ENV]
  : COMMON_REQUIRED_ENV;
const env = Object.fromEntries(ALL_ENV.map((name) => [name, clean(process.env[name])]));
const missing = requiredEnv.filter((name) => !env[name]);
const signalwireRealm = clean(process.env.SIGNALWIRE_SIP_REALM) || signalwireSipHostFromSpaceUrl(env.SIGNALWIRE_SPACE_URL);
const signalwireProxy = clean(process.env.SIGNALWIRE_SIP_PROXY) || signalwireRealm;
const signalwireDidDigits = env.SIGNALWIRE_FROM_NUMBER.replace(/\D/g, "");
const signalwireDidNational = signalwireDidDigits.length === 11 && signalwireDidDigits.startsWith("1")
  ? signalwireDidDigits.slice(1)
  : "";
const signalwireDidPattern = didPattern(env.SIGNALWIRE_FROM_NUMBER);
const outputDir = path.resolve(repoRoot, argValue("--out-dir", "artifacts/freeswitch-signalwire/conf"));
const manifestPath = path.resolve(repoRoot, argValue("--manifest", "artifacts/freeswitch-signalwire/readiness.json"));
const artifactsRoot = path.resolve(repoRoot, "artifacts");
const outputDirIsArtifact = isPathInside(artifactsRoot, outputDir)
  && !(await hasSymlinkedAncestor(artifactsRoot, outputDir));
const redactor = buildRedactor([
  ...Object.values(env),
  signalwireRealm,
  signalwireProxy,
  signalwireDidPattern,
  signalwireDidDigits,
  signalwireDidNational,
  process.env.SIGNALWIRE_PROJECT_ID,
  process.env.SIGNALWIRE_TOKEN,
  process.env.SIGNALWIRE_SIP_REALM,
  process.env.SIGNALWIRE_SIP_PROXY,
]);

const summary = {
  ok: false,
  status: "blocked",
  manualCallReady: false,
  telephonyMode: "signalwire_live",
  trunkMode,
  requiredEnv,
  missingEnv: missing,
  endpoint: {
    signalwireRealm: signalwireRealm ? redact(signalwireRealm) : null,
    signalwireProxy: signalwireProxy ? redact(signalwireProxy) : null,
    sipUsername: env.SIGNALWIRE_SIP_USERNAME ? redact(env.SIGNALWIRE_SIP_USERNAME) : null,
    fromNumber: env.SIGNALWIRE_FROM_NUMBER ? redact(env.SIGNALWIRE_FROM_NUMBER) : null,
    freeswitchPublicSipHost: env.FREESWITCH_PUBLIC_SIP_HOST ? redact(env.FREESWITCH_PUBLIC_SIP_HOST) : null,
  },
  generatedConfig: null,
  freeswitchCli: [],
  blockers: [],
};

if (!["registration", "ip_auth"].includes(trunkMode)) {
  summary.blockers.push("invalid_signalwire_trunk_mode");
} else if (missing.length) {
  summary.blockers.push("missing_signalwire_or_freeswitch_env");
} else if (!signalwireDidDigits) {
  summary.blockers.push("invalid_signalwire_from_number");
} else if (trunkMode === "registration" && (!signalwireRealm || !signalwireProxy)) {
  summary.missingEnv.push("SIGNALWIRE_SIP_REALM_OR_PROXY");
  summary.blockers.push("missing_signalwire_sip_realm_or_proxy");
}

if (hasFlag("--render") && !outputDirIsArtifact) {
  summary.blockers.push("unsafe_freeswitch_output_dir");
}

const replacements = {
  SIGNALWIRE_SIP_USERNAME: xmlEscape(env.SIGNALWIRE_SIP_USERNAME),
  SIGNALWIRE_SIP_PASSWORD: xmlEscape(env.SIGNALWIRE_SIP_PASSWORD),
  SIGNALWIRE_SIP_REALM: xmlEscape(signalwireRealm),
  SIGNALWIRE_SIP_PROXY: xmlEscape(signalwireProxy),
  SIGNALWIRE_TO_NUMBER_PATTERN: signalwireDidPattern,
  SIGNALWIRE_FROM_NUMBER_SAFE: xmlEscape(env.SIGNALWIRE_FROM_NUMBER),
  FREESWITCH_PUBLIC_SIP_HOST_SAFE: xmlEscape(env.FREESWITCH_PUBLIC_SIP_HOST),
};

if (hasFlag("--render") && summary.blockers.length === 0) {
  const gatewayOutputPath = path.join(outputDir, "sip_profiles/external/signalwire.xml");
  const dialplanOutputPath = path.join(outputDir, "dialplan/public/signalwire_inbound.xml");
  for (const destinationPath of [gatewayOutputPath, dialplanOutputPath]) {
    if (!(await safeArtifactOutputPath(destinationPath))) {
      summary.blockers.push("unsafe_freeswitch_output_dir");
      break;
    }
    if (await isMultiplyLinkedDestination(destinationPath)) {
      summary.blockers.push("unsafe_freeswitch_output_link");
      break;
    }
  }
}

if (hasFlag("--render") && summary.blockers.length === 0) {
  const gatewayOutputPath = path.join(outputDir, "sip_profiles/external/signalwire.xml");
  const dialplanOutputPath = path.join(outputDir, "dialplan/public/signalwire_inbound.xml");
  const gatewayPath = trunkMode === "registration"
    ? await renderTemplate(
      path.join(repoRoot, "freeswitch/templates/signalwire-gateway.xml.template"),
      gatewayOutputPath,
      replacements,
    )
    : null;
  if (trunkMode === "ip_auth") {
    await rm(gatewayOutputPath, { force: true });
  }
  const dialplanPath = await renderTemplate(
    path.join(repoRoot, "freeswitch/templates/signalwire_inbound.xml.template"),
    dialplanOutputPath,
    replacements,
  );
  summary.generatedConfig = {
    gatewayPath: gatewayPath ? path.relative(repoRoot, gatewayPath) : null,
    dialplanPath: path.relative(repoRoot, dialplanPath),
    gitignored: outputDirIsArtifact,
  };
}

const fsCliSkipped = hasFlag("--skip-fs-cli");
const rawFsCli = new Map();

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const dialplanCommand = "xml_locate dialplan extension name agentic_contact_center_signalwire_pstn";
  const commands = trunkMode === "ip_auth"
    ? ["sofia status profile external", "show registrations", dialplanCommand]
    : ["sofia status profile external", "sofia status gateway signalwire", "show registrations", dialplanCommand];
  for (const command of commands) {
    try {
      const result = await runFsCli(command, redactor);
      summary.freeswitchCli.push(result.proof);
      rawFsCli.set(command, result.raw);
    } catch (error) {
      summary.blockers.push(
        trunkMode === "ip_auth"
          ? "freeswitch_cli_unavailable_or_external_profile_unready"
          : "freeswitch_cli_unavailable_or_gateway_unregistered",
      );
      summary.freeswitchCli.push({
        command: `fs_cli -x '${command}'`,
        error: redactor(error instanceof Error ? error.message : String(error)),
      });
      break;
    }
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const externalProfile = rawFsCli.get("sofia status profile external");
  if (!isExternalProfileRunning(externalProfile)) {
    summary.blockers.push("freeswitch_external_profile_not_running");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped && trunkMode === "ip_auth") {
  const publicAddresses = await resolvePublicEndpointAddresses(env.FREESWITCH_PUBLIC_SIP_HOST);
  const externalProfile = rawFsCli.get("sofia status profile external");
  if (!isIpAuthEndpointAdvertised(externalProfile, publicAddresses)) {
    summary.blockers.push("freeswitch_public_sip_endpoint_not_proven");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const gateway = rawFsCli.get("sofia status gateway signalwire");
  if (trunkMode === "registration" && gateway && !/\bREGED\b/i.test(`${gateway.stdout}\n${gateway.stderr}`)) {
    summary.blockers.push("signalwire_gateway_status_not_proven");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const dialplan = rawFsCli.get("xml_locate dialplan extension name agentic_contact_center_signalwire_pstn");
  if (!isInboundDialplanActive(dialplan, signalwireDidPattern)) {
    summary.blockers.push("signalwire_inbound_dialplan_not_proven");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const registrations = rawFsCli.get("show registrations");
  if (!isVertoAgentContactRegistered(registrations)) {
    summary.blockers.push("verto_agent_contact_not_proven");
  }
}

summary.ok = summary.blockers.length === 0;
summary.manualCallReady = summary.ok && !fsCliSkipped;
summary.status = summary.manualCallReady ? "ready_for_manual_pstn_call" : summary.ok ? "config_rendered_pending_freeswitch_cli" : "blocked";

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 2);
