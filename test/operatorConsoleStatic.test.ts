import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("operator console surfaces runtime labels and Pipecat media-engine readiness", () => {
  const html = readFileSync("apps/web/src/index.html", "utf8");
  const app = readFileSync("apps/web/src/app.js", "utf8");

  assert.match(html, /id="runtime-labels"/);
  assert.match(html, /id="media-engine"/);
  assert.match(app, /runtimeModeLabels/);
  assert.match(app, /\/api\/pipecat-media-engine\/readiness/);
  assert.match(app, /sip_freeswitch_rtp/);
  assert.match(app, /signalwire_sip_trunk/);
});
