#!/usr/bin/env node
import net from "node:net";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function argValue(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

async function postJson(baseUrl, route, body) {
  const url = new URL(route, baseUrl);
  const rawBody = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": rawBody.length } },
      (res) => {
        let collected = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { collected += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function parseHeaders(block) {
  const headers = new Map();
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim(), decodeURIComponent(line.slice(index + 1).trim().replaceAll("+", "%20")));
  }
  return headers;
}

class EslBridge {
  constructor(options) {
    this.options = options;
    this.buffer = "";
    this.events = [];
    this.callMap = new Map();
  }

  async start() {
    await mkdir(this.options.recordingDir, { recursive: true });
    this.socket = net.createConnection({ host: this.options.eslHost, port: this.options.eslPort });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => void this.handleData(chunk));
    this.socket.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    this.socket.on("close", () => void this.flushLog());
  }

  send(command) {
    this.socket.write(`${command}\n\n`);
  }

  async handleData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n\n")) {
      const index = this.buffer.indexOf("\n\n");
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      await this.handleBlock(block);
    }
  }

  async handleBlock(block) {
    const headers = parseHeaders(block);
    const contentType = headers.get("Content-Type");
    this.events.push({ at: nowIso(), headers: Object.fromEntries(headers) });
    if (contentType === "auth/request") {
      this.send(`auth ${this.options.password}`);
      this.send("event plain CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE RECORD_STOP");
      this.send("filter Event-Name CHANNEL_ANSWER");
      this.send("filter Event-Name CHANNEL_HANGUP_COMPLETE");
      this.send("filter Event-Name RECORD_STOP");
      return;
    }
    if (contentType !== "text/event-plain") return;
    const eventName = headers.get("Event-Name");
    const uuid = headers.get("Unique-ID");
    if (!uuid) return;
    if (eventName === "CHANNEL_ANSWER") await this.onAnswer(uuid, headers);
    if (eventName === "RECORD_STOP") await this.onRecordStop(uuid, headers);
    if (eventName === "CHANNEL_HANGUP_COMPLETE") await this.onHangup(uuid, headers);
  }

  async onAnswer(uuid, headers) {
    if (this.callMap.has(uuid)) return;
    const destination = headers.get("Caller-Destination-Number") ?? "8600";
    const wavPath = path.join(this.options.recordingDir, `${uuid}.wav`);
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      source: "freeswitch_esl",
      telephonyMode: this.options.telephonyMode,
      rtcAsrMode: this.options.rtcAsrUrl ? "rtc_asr_live" : "rtc_asr_blocked",
      destination,
    });
    this.callMap.set(uuid, { wavPath, startedAt: Date.now() });
    this.send(`api uuid_record ${uuid} start ${wavPath}`);
  }

  async onRecordStop(uuid) {
    const call = this.callMap.get(uuid);
    if (!call) return;
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      audioWavPath: call.wavPath,
      sipLogPath: this.options.logPath,
      generatedMedia: false,
    });
    if (!this.options.rtcAsrUrl) {
      await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
        eventType: "rtc_asr.blocked",
        timestamp: nowIso(),
        sipCallId: uuid,
        fsUuid: uuid,
        blocker: "RTC_ASR_WS_URL unset or rtc-asr sidecar unavailable",
        nextAction: "Start rtc-asr and set RTC_ASR_WS_URL before rerunning FreeSWITCH bridge proof.",
      });
    }
  }

  async onHangup(uuid, headers) {
    const call = this.callMap.get(uuid);
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      hangupCause: headers.get("Hangup-Cause") ?? null,
      durationSeconds: call ? Math.round((Date.now() - call.startedAt) / 1000) : null,
    });
    this.callMap.delete(uuid);
  }

  async flushLog() {
    await mkdir(path.dirname(this.options.logPath), { recursive: true });
    await writeFile(this.options.logPath, `${JSON.stringify({ generatedAt: nowIso(), events: this.events }, null, 2)}\n`, "utf8");
  }
}

async function main() {
  const bridge = new EslBridge({
    eslHost: argValue("--esl-host", process.env.FREESWITCH_ESL_HOST || "127.0.0.1"),
    eslPort: Number(argValue("--esl-port", process.env.FREESWITCH_ESL_PORT || "8021")),
    password: argValue("--esl-password", process.env.FREESWITCH_ESL_PASSWORD || "ClueCon"),
    accBaseUrl: argValue("--acc-url", process.env.ACC_BASE_URL || "http://127.0.0.1:8026"),
    recordingDir: path.resolve(process.cwd(), argValue("--recording-dir", "artifacts/freeswitch-live/media")),
    logPath: path.resolve(process.cwd(), argValue("--log", "artifacts/freeswitch-live/freeswitch-esl-events.json")),
    rtcAsrUrl: argValue("--rtc-asr-url", process.env.RTC_ASR_WS_URL),
    telephonyMode: argValue("--telephony-mode", process.env.ACC_TELEPHONY_MODE || "local_sip"),
  });
  await bridge.start();
  console.log(`FreeSWITCH ACC bridge connected target ${bridge.options.eslHost}:${bridge.options.eslPort}; ACC ${bridge.options.accBaseUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
