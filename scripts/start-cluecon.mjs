#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const defaultRtcAsrBaseUrl = "http://127.0.0.1:8080";
const defaultKokoroBaseUrl = "http://127.0.0.1:8880";
const rtcAsrBaseUrl = (process.env.RTC_ASR_BASE_URL || defaultRtcAsrBaseUrl).replace(/\/+$/, "");
const rtcAsrRepo = resolve(process.env.RTC_ASR_REPO || "../rtc-asr");
const startupTimeoutMs = Number(process.env.CLUECON_ASR_START_TIMEOUT_MS || 600_000);
const pollIntervalMs = Number(process.env.CLUECON_ASR_POLL_MS || 2_000);
const checkOnly = process.argv.includes("--check-only");

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function probeJson(url, timeoutMs = 3_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    const status = String(payload.status || "").toLowerCase();
    return {
      ok: response.ok && payload.ready !== false && !["offline", "error", "failed", "degraded"].includes(status),
      payload,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function rtcAsrIsReady() {
  const health = await probeJson(`${rtcAsrBaseUrl}/health`);
  if (!health.ok) return false;
  const ready = await probeJson(`${rtcAsrBaseUrl}/ready`);
  return ready.ok;
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function startLocalRtcAsr() {
  const composeFile = resolve(rtcAsrRepo, "docker-compose.yml");
  if (!existsSync(composeFile)) {
    throw new Error(
      `rtc-asr is unavailable at ${rtcAsrBaseUrl}, and no sibling checkout was found at ${rtcAsrRepo}. `
      + "Start rtc-asr manually or set RTC_ASR_REPO / RTC_ASR_BASE_URL.",
    );
  }

  console.log(`[cluecon] Starting rtc-asr from ${rtcAsrRepo} ...`);
  const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
  const result = spawnSync(
    dockerCommand,
    ["compose", "up", "-d", "--build", "asr-service"],
    { cwd: rtcAsrRepo, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`rtc-asr Compose startup exited with status ${result.status}.`);
}

async function ensureRtcAsr() {
  if (await rtcAsrIsReady()) {
    console.log(`[cluecon] rtc-asr ready at ${rtcAsrBaseUrl}.`);
    return;
  }

  if (!isLoopbackUrl(rtcAsrBaseUrl)) {
    throw new Error(
      `Configured rtc-asr endpoint ${rtcAsrBaseUrl} is unavailable. `
      + "The launcher only auto-starts a local loopback sidecar.",
    );
  }

  startLocalRtcAsr();
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await rtcAsrIsReady()) {
      console.log(`[cluecon] rtc-asr ready at ${rtcAsrBaseUrl}.`);
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`rtc-asr did not become ready within ${startupTimeoutMs} ms.`);
}

async function discoverKokoroBaseUrl() {
  if (process.env.KOKORO_BASE_URL) return process.env.KOKORO_BASE_URL;
  const probe = await probeJson(`${defaultKokoroBaseUrl}/health`);
  return probe.ok ? defaultKokoroBaseUrl : undefined;
}

async function main() {
  await ensureRtcAsr();
  if (checkOnly) return;

  const appEntry = resolve("dist/src/index.js");
  if (!existsSync(appEntry)) throw new Error("Build output is missing. Run npm run build before the ClueCon launcher.");

  const kokoroBaseUrl = await discoverKokoroBaseUrl();
  const rtcAsrWsUrl = process.env.RTC_ASR_WS_URL
    || `${rtcAsrBaseUrl.replace(/^http/i, "ws")}/v1/stt/stream`;
  const child = spawn(process.execPath, [appEntry], {
    env: {
      ...process.env,
      RTC_ASR_BASE_URL: rtcAsrBaseUrl,
      RTC_ASR_WS_URL: rtcAsrWsUrl,
      ...(kokoroBaseUrl ? { KOKORO_BASE_URL: kokoroBaseUrl } : {}),
    },
    stdio: "inherit",
  });

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(`[cluecon] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
