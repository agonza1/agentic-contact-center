#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const args = process.argv.slice(2);

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
    && output.includes(expectedDidPattern);
}

function isPublicIpAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized));
  }
  return false;
}

function normalizeSipEndpointHost(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `sip://${raw}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw.replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
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

function isIpAuthEndpointAdvertised(entry, expectedAddresses) {
  if (!entry || expectedAddresses.length === 0) return false;
  const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
  const advertised = [...output.matchAll(/^\s*(?:ext-)?sip-ip(?:\s*[:=]\s*|\s+)(\S+)/gim)]
    .map((match) => match[1].replace(/^\[|\]$/g, "").replace(/:\d+$/, ""));
  return expectedAddresses.some((address) => advertised.includes(address));
}

async function renderTemplate(templatePath, outputPath, replacements) {
  let text = await readFile(templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`__${key}__`, value);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, text, { mode: 0o600 });
  return outputPath;
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
} else if (trunkMode === "registration" && (!signalwireRealm || !signalwireProxy)) {
  summary.missingEnv.push("SIGNALWIRE_SIP_REALM_OR_PROXY");
  summary.blockers.push("missing_signalwire_sip_realm_or_proxy");
}

if (hasFlag("--render") && summary.blockers.length === 0) {
  const replacements = {
    SIGNALWIRE_SIP_USERNAME: xmlEscape(env.SIGNALWIRE_SIP_USERNAME),
    SIGNALWIRE_SIP_PASSWORD: xmlEscape(env.SIGNALWIRE_SIP_PASSWORD),
    SIGNALWIRE_SIP_REALM: xmlEscape(signalwireRealm),
    SIGNALWIRE_SIP_PROXY: xmlEscape(signalwireProxy),
    SIGNALWIRE_TO_NUMBER_PATTERN: signalwireDidPattern,
    SIGNALWIRE_FROM_NUMBER_SAFE: xmlEscape(env.SIGNALWIRE_FROM_NUMBER),
    FREESWITCH_PUBLIC_SIP_HOST_SAFE: xmlEscape(env.FREESWITCH_PUBLIC_SIP_HOST),
  };
  const gatewayOutputPath = path.join(outputDir, "sip_profiles/external/signalwire.xml");
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
    path.join(outputDir, "dialplan/public/signalwire_inbound.xml"),
    replacements,
  );
  summary.generatedConfig = {
    gatewayPath: gatewayPath ? path.relative(repoRoot, gatewayPath) : null,
    dialplanPath: path.relative(repoRoot, dialplanPath),
    gitignored: true,
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

summary.ok = summary.blockers.length === 0;
summary.manualCallReady = summary.ok && !fsCliSkipped;
summary.status = summary.manualCallReady ? "ready_for_manual_pstn_call" : summary.ok ? "config_rendered_pending_freeswitch_cli" : "blocked";

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 2);
