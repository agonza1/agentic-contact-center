#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    return redacted;
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
    command: `fs_cli -x '${command}'`,
    stdout: redactor(stdout.trim()),
    stderr: redactor(stderr.trim()),
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
const outputDir = path.resolve(repoRoot, argValue("--out-dir", "artifacts/freeswitch-signalwire/conf"));
const manifestPath = path.resolve(repoRoot, argValue("--manifest", "artifacts/freeswitch-signalwire/readiness.json"));
const redactor = buildRedactor([
  ...Object.values(env),
  signalwireRealm,
  signalwireProxy,
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
    SIGNALWIRE_TO_NUMBER_PATTERN: didPattern(env.SIGNALWIRE_FROM_NUMBER),
    SIGNALWIRE_FROM_NUMBER_SAFE: xmlEscape(env.SIGNALWIRE_FROM_NUMBER),
    FREESWITCH_PUBLIC_SIP_HOST_SAFE: xmlEscape(env.FREESWITCH_PUBLIC_SIP_HOST),
  };
  const gatewayPath = trunkMode === "registration"
    ? await renderTemplate(
      path.join(repoRoot, "freeswitch/templates/signalwire-gateway.xml.template"),
      path.join(outputDir, "sip_profiles/external/signalwire.xml"),
      replacements,
    )
    : null;
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

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const commands = trunkMode === "ip_auth"
    ? ["sofia status profile external", "show registrations"]
    : ["sofia status profile external", "sofia status gateway signalwire", "show registrations"];
  for (const command of commands) {
    try {
      summary.freeswitchCli.push(await runFsCli(command, redactor));
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
  const externalProfile = summary.freeswitchCli.find((entry) => entry.command.includes("profile external"));
  if (!isExternalProfileRunning(externalProfile)) {
    summary.blockers.push("freeswitch_external_profile_not_running");
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const gateway = summary.freeswitchCli.find((entry) => entry.command.includes("gateway signalwire"));
  if (trunkMode === "registration" && gateway && !/\bREGED\b/i.test(`${gateway.stdout}\n${gateway.stderr}`)) {
    summary.blockers.push("signalwire_gateway_status_not_proven");
  }
}

summary.ok = summary.blockers.length === 0;
summary.manualCallReady = summary.ok && !fsCliSkipped;
summary.status = summary.manualCallReady ? "ready_for_manual_pstn_call" : summary.ok ? "config_rendered_pending_freeswitch_cli" : "blocked";

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 2);
