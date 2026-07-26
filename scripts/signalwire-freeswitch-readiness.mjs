#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const args = process.argv.slice(2);

const REQUIRED_ENV = [
  "SIGNALWIRE_SPACE_URL",
  "SIGNALWIRE_SIP_USERNAME",
  "SIGNALWIRE_SIP_PASSWORD",
  "SIGNALWIRE_FROM_NUMBER",
  "FREESWITCH_PUBLIC_SIP_HOST",
];

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

const env = Object.fromEntries(REQUIRED_ENV.map((name) => [name, clean(process.env[name])]));
const missing = REQUIRED_ENV.filter((name) => !env[name]);
const signalwireRealm = clean(process.env.SIGNALWIRE_SIP_REALM) || normalizeSpaceHost(env.SIGNALWIRE_SPACE_URL);
const signalwireProxy = clean(process.env.SIGNALWIRE_SIP_PROXY) || signalwireRealm;
const outputDir = path.resolve(repoRoot, argValue("--out-dir", "artifacts/freeswitch-signalwire/conf"));
const manifestPath = path.resolve(repoRoot, argValue("--manifest", "artifacts/freeswitch-signalwire/readiness.json"));
const redactor = buildRedactor([
  ...Object.values(env),
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
  requiredEnv: REQUIRED_ENV,
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

if (missing.length) {
  summary.blockers.push("missing_signalwire_or_freeswitch_env");
} else if (!signalwireRealm || !signalwireProxy) {
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
  const gatewayPath = await renderTemplate(
    path.join(repoRoot, "freeswitch/templates/signalwire-gateway.xml.template"),
    path.join(outputDir, "sip_profiles/external/signalwire.xml"),
    replacements,
  );
  const dialplanPath = await renderTemplate(
    path.join(repoRoot, "freeswitch/templates/signalwire_inbound.xml.template"),
    path.join(outputDir, "dialplan/public/signalwire_inbound.xml"),
    replacements,
  );
  summary.generatedConfig = {
    gatewayPath: path.relative(repoRoot, gatewayPath),
    dialplanPath: path.relative(repoRoot, dialplanPath),
    gitignored: true,
  };
}

const fsCliSkipped = hasFlag("--skip-fs-cli");

if (summary.blockers.length === 0 && !fsCliSkipped) {
  for (const command of ["sofia status profile external", "sofia status gateway signalwire", "show registrations"]) {
    try {
      summary.freeswitchCli.push(await runFsCli(command, redactor));
    } catch (error) {
      summary.blockers.push("freeswitch_cli_unavailable_or_gateway_unregistered");
      summary.freeswitchCli.push({
        command: `fs_cli -x '${command}'`,
        error: redactor(error instanceof Error ? error.message : String(error)),
      });
      break;
    }
  }
}

if (summary.blockers.length === 0 && !fsCliSkipped) {
  const gateway = summary.freeswitchCli.find((entry) => entry.command.includes("gateway signalwire"));
  if (gateway && !/\bREGED\b/i.test(`${gateway.stdout}\n${gateway.stderr}`)) {
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
