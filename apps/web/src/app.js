const state = {
  sessionId: null,
  fallbackEnabled: false,
};

const ids = [
  "start-presentation",
  "refresh-session",
  "simulate-telephony",
  "attach-openclaw",
  "slack-slide",
  "toggle-fallback",
  "send-question",
];

function setEnabled(enabled) {
  ids.forEach((id) => {
    document.getElementById(id).disabled = !enabled;
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || `Request failed: ${response.status}`);
  }
  return response.json();
}

function render(session) {
  state.fallbackEnabled = Boolean(session.poc?.fallback?.enabled);
  document.getElementById("toggle-fallback").textContent = state.fallbackEnabled ? "Disable fallback" : "Enable fallback";
  const runtimeModeLabels = session.poc?.runtime_labels || session.session?.runtimeModeLabels || {};
  document.getElementById("session-summary").textContent = JSON.stringify({
    session_id: session.session_id,
    deck_name: session.deck_name,
    status: session.presentation_status,
    current_slide: session.current_slide,
  }, null, 2);
  document.getElementById("runtime-labels").textContent = JSON.stringify({
    telephony: runtimeModeLabels.telephony || "unknown",
    media: runtimeModeLabels.media || "unknown",
    rtc_asr: runtimeModeLabels.rtc_asr || runtimeModeLabels.rtcAsr || "unknown",
    credentials: runtimeModeLabels.credentials || runtimeModeLabels.credentialsMode || "unknown",
  }, null, 2);
  document.getElementById("poc-status").textContent = JSON.stringify(session.poc, null, 2);
  document.getElementById("recent-events").textContent = JSON.stringify(session.recent_events, null, 2);
  document.getElementById("transcript").textContent = JSON.stringify(session.transcript, null, 2);
}

async function refresh() {
  if (!state.sessionId) return;
  const session = await api(`/api/poc/sessions/${state.sessionId}`);
  render(session);
}

async function refreshMediaEngineReadiness() {
  const statusNode = document.getElementById("media-engine");
  try {
    const readiness = await api("/api/pipecat-media-engine/readiness");
    const adapters = readiness.sharedEngineContract?.requiredAdapters || [];
    statusNode.textContent = JSON.stringify({
      status: readiness.status,
      review_ready: readiness.reviewReady,
      browser_webrtc: adapters.find((adapter) => adapter.id === "browser_webrtc")?.implementedNow || false,
      local_sip: adapters.find((adapter) => adapter.id === "sip_freeswitch_rtp")?.implementedNow || false,
      signalwire_trunk: adapters.find((adapter) => adapter.id === "signalwire_sip_trunk")?.implementedNow || false,
      next_slice: readiness.nextUnblockedSlice?.id || null,
      next_slice_verification: readiness.nextUnblockedSlice?.verification || null,
      blocker: readiness.reviewBlockers?.[0] || null,
    }, null, 2);
  } catch (error) {
    statusNode.textContent = JSON.stringify({ status: "unavailable", detail: error.message }, null, 2);
  }
}

document.getElementById("create-session").addEventListener("click", async () => {
  const session = await api("/api/poc/sessions", { method: "POST", body: { operator_notes: "Created from live ops UI" } });
  state.sessionId = session.session_id;
  setEnabled(true);
  render(session);
});

document.getElementById("start-presentation").addEventListener("click", async () => {
  const session = await api(`/api/poc/sessions/${state.sessionId}/presentation/start`, { method: "POST", body: {} });
  render(session);
});

document.getElementById("refresh-session").addEventListener("click", refresh);

document.getElementById("simulate-telephony").addEventListener("click", async () => {
  const session = await api(`/api/poc/sessions/${state.sessionId}/telephony-ingress`, {
    method: "POST",
    body: { provider: "signalwire", caller: "+13125550123", call_id: "sw-demo-ui-001", operator_notes: "Simulated from live ops" },
  });
  render(session);
});

document.getElementById("attach-openclaw").addEventListener("click", async () => {
  const session = await api(`/api/poc/sessions/${state.sessionId}/openclaw-session`, {
    method: "POST",
    body: { session_id: "oc-demo-001", label: "ClueCon per-call console" },
  });
  render(session);
});

document.getElementById("slack-slide").addEventListener("click", async () => {
  const session = await api(`/api/poc/sessions/${state.sessionId}/slack-steer`, {
    method: "POST",
    body: { command: "goto-slide", slide_number: 2, requested_by: "demo-operator-console" },
  });
  render(session);
});

document.getElementById("toggle-fallback").addEventListener("click", async () => {
  const session = await api(`/api/poc/sessions/${state.sessionId}/fallback`, {
    method: "POST",
    body: { enabled: !state.fallbackEnabled, rationale: !state.fallbackEnabled ? "Operator wants manual narration path." : "Returning to live voice path.", armed_by: "demo-operator-console" },
  });
  render(session);
});

document.getElementById("send-question").addEventListener("click", async () => {
  const question = document.getElementById("question-input").value;
  const session = await api(`/api/poc/sessions/${state.sessionId}/question`, { method: "POST", body: { question, channel: "text" } });
  render(session);
});

refreshMediaEngineReadiness();
