import { SCRIPTED_CALLER_TURNS, getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
import type { PocConfig } from "../core/types";

export function buildClueConPayload(config: PocConfig) {
  const pipecat = getPipecatPrototypeHealth();

  return {
    ok: true,
    route: "/api/cluecon",
    issue: "agonza1/agentic-contact-center#177",
    workboardCard: "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae",
    title: "From SIP to Tokens: Deterministic Telephony Meets Real-Time Voice AI",
    thesis:
      "SIP gives deterministic call state. Pipecat gives the media runtime. rtc-asr gives the local STT boundary. OpenClaw-style harnessing controls the agent. Kokoro speaks locally. ConversationAgentEvals / ASSERT proves whether the workflow completed safely.",
    routes: {
      scrollable: "/cluecon",
      present: "/cluecon/present",
      scriptedDemo: "/api/demo/run-end-to-end",
      operatorConsole: "/operator/console",
      proofViewer: "/assert",
      assertSpec: "/assert/spec",
      realtimeShimReadiness: "/api/realtime-shim/readiness",
      realtimeShimProof: "/api/realtime-shim/proof",
    },
    readiness: [
      {
        id: "acc",
        label: "ACC app",
        status: "ready",
        detail: `${config.demoName} HTTP runtime is serving local demo and proof routes.`,
        caveat: "Local process only; not a hosted production deployment.",
      },
      {
        id: "pipecat",
        label: "Pipecat transport",
        status: pipecat.ready ? "ready" : "blocked",
        detail: `${pipecat.runtimeEngine} via ${pipecat.transport}; verify with ${pipecat.runtimeCheck.command}.`,
        caveat: "Browser voice needs the local Pipecat bridge; scripted mode remains valid without it.",
      },
      {
        id: "rtc_asr",
        label: "rtc-asr Local STT v1",
        status: "fixture",
        detail: "Readiness and stream events are shown from fixture mode unless rtc-asr is reachable locally.",
        caveat: "Unavailable rtc-asr is a blocker state, not a fake transcript.",
      },
      {
        id: "kokoro",
        label: "Kokoro TTS",
        status: "fixture",
        detail: "Kokoro is marked unavailable for this slice and falls back to text/local TTS.",
        caveat: "The UI is honest about TTS fallback during the talk path.",
      },
      {
        id: "eval",
        label: "ConversationAgentEvals / ASSERT",
        status: "ready",
        detail: "The scripted run exposes a proof bundle preview and ASSERT-compatible request handoff.",
        caveat: "Local ASSERT viewer export is separate from importing into ConversationAgentEvals.",
      },
    ],
    scenario: {
      name: "cancellation_rescue_seeded_script",
      callerTurns: [...SCRIPTED_CALLER_TURNS],
      operatorMoment: "renewal_increase_requires_safe_offer_review",
      failureDrills: ["tool_timeout", "runtime_failure", "rtc_asr_unavailable", "tts_unavailable"],
    },
    brainBlocks: [
      ["mission.md", "Rescue an at-risk cancellation only inside approved retention boundaries.", "agent response, final state"],
      ["policy.md", "Pause before risky offers, require operator approval, and fail closed on runtime uncertainty.", "policy hold, fallback"],
      ["tools.md", "Expose bounded call controls, slide controls, proof export, and operator steer actions.", "active tool, action trace"],
      ["operator.md", "Ask for human steer at the retention boundary and record approval or escalation evidence.", "operator hold, proof bundle"],
      ["fallback.md", "Escalate to a human instead of improvising when ASR, TTS, tools, or runtime are unavailable.", "handoff, caveats"],
      ["eval.md", "Score task completion, policy compliance, final state, latency, and evidence quality.", "ASSERT request, scorecard"],
    ].map(([file, summary, affects]) => ({ file, summary, affects: String(affects).split(/,\s*/) })),
    proofPreview: {
      includes: ["transcript", "events", "action trace", "latency marks", "final state", "fallback state", "OpenClaw artifact links", "ASR/TTS caveats"],
      compatibleRequest: "conversation-agent-evals-assert-request.json",
      primaryClaim: "The demo is complete when the evidence proves the workflow completed safely.",
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

export function buildClueConHtml(config: PocConfig, mode: "scroll" | "present"): string {
  const payload = buildClueConPayload(config);
  const data = JSON.stringify(payload);
  const bodyClass = mode === "present" ? "present" : "scroll";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.title)}</title>
  <style>
    :root { --bg: #f5f7f8; --panel: #fff; --ink: #17202a; --muted: #5d6b78; --line: #d8e0e7; --teal: #0f766e; --blue: #2457a6; --red: #b42318; --amber: #9a5b04; --green: #167247; --shadow: 0 14px 34px rgba(20, 34, 46, 0.09); }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: var(--blue); font-weight: 750; text-decoration: none; }
    button, textarea { font: inherit; }
    button { min-height: 38px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-weight: 760; cursor: pointer; }
    button.primary { background: var(--teal); border-color: var(--teal); color: #fff; }
    button.danger { color: var(--red); border-color: #efb4ac; background: #fff4f2; }
    button:disabled { opacity: 0.52; cursor: wait; }
    .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 22px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.96); backdrop-filter: blur(12px); }
    .brand { display: grid; gap: 2px; min-width: 240px; }
    .kicker { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    h1, h2, h3, p { margin-top: 0; letter-spacing: 0; }
    h1 { max-width: 980px; font-size: clamp(36px, 7vw, 78px); line-height: .96; margin-bottom: 18px; }
    h2 { font-size: clamp(26px, 4vw, 46px); line-height: 1.02; margin-bottom: 10px; }
    h3 { font-size: 15px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .toolbar a, .mode-link { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-size: 13px; }
    .hero, .slide { min-height: calc(100vh - 62px); padding: 54px clamp(18px, 5vw, 72px); display: grid; align-content: center; gap: 22px; border-bottom: 1px solid var(--line); }
    .hero { background: linear-gradient(180deg, #ffffff 0%, #eef4f4 100%); }
    .subhead { max-width: 850px; color: #334155; font-size: clamp(18px, 2.2vw, 25px); line-height: 1.38; }
    .section-band { padding: 42px clamp(18px, 5vw, 72px); border-bottom: 1px solid var(--line); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .8fr); gap: 18px; align-items: start; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); box-shadow: var(--shadow); min-width: 0; }
    .plain { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; min-width: 0; }
    .metric { display: grid; gap: 5px; }
    .metric strong { font-size: 20px; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .badge { display: inline-flex; min-height: 24px; align-items: center; width: fit-content; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; font-weight: 800; }
    .ready { color: var(--green); background: #ecfdf3; border-color: #a8ddb8; }
    .fixture { color: var(--amber); background: #fff8e8; border-color: #f2c879; }
    .blocked { color: var(--red); background: #fff2f0; border-color: #f0b8b2; }
    .arch { width: 100%; min-height: 300px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .node { fill: #fff; stroke: #bac6d1; stroke-width: 2; }
    .nodeAccent { fill: #e8f5f2; stroke: #0f766e; stroke-width: 2; }
    .nodeWarn { fill: #fff8e8; stroke: #9a5b04; stroke-width: 2; }
    .label { font: 800 15px system-ui,sans-serif; fill: #17202a; }
    .small { font: 650 12px system-ui,sans-serif; fill: #5d6b78; }
    .line { stroke: #2457a6; stroke-width: 2.8; fill: none; marker-end: url(#arrow); }
    .demo-shell { display: grid; gap: 12px; }
    .screen { min-height: 360px; border: 1px solid var(--line); border-radius: 8px; background: #101820; color: #dbeafe; padding: 14px; overflow: auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .timeline { display: grid; gap: 8px; }
    .event { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    .brain { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
    textarea { width: 100%; min-height: 108px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 9px; color: var(--ink); }
    .proof-pre { margin: 0; min-height: 260px; max-height: 460px; overflow: auto; border-radius: 8px; padding: 12px; background: #0d1117; color: #e6edf3; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .present .topbar { position: fixed; width: 100%; }
    .present main { padding-top: 62px; }
    .present .slide, .present .hero { min-height: calc(100vh - 62px); }
    .present .section-band:not(.active), .present .hero:not(.active) { display: none; }
    @media (max-width: 920px) { .two { grid-template-columns: 1fr; } .topbar { position: static; align-items: stretch; flex-direction: column; } .toolbar { justify-content: flex-start; } .hero, .slide, .section-band { padding: 28px 14px; } h1 { font-size: 38px; } .event { grid-template-columns: 1fr; } }
  </style>
</head>
<body class="${bodyClass}">
  <header class="topbar"><div class="brand"><span class="kicker">ClueCon vertical slice</span><strong>Agentic Contact Center</strong></div><nav class="toolbar" aria-label="ClueCon sections"><a href="/cluecon">Narrative</a><a href="/cluecon/present">Present</a><a href="/operator/console">Operator</a><a href="/assert">Proof</a><button id="prev" type="button">Prev</button><button id="next" type="button" class="primary">Next</button></nav></header>
  <main>
    <section class="hero active" data-slide="0"><span class="kicker">From SIP to Tokens</span><h1>${escapeHtml(payload.title)}</h1><p class="subhead">${escapeHtml(payload.thesis)}</p><div class="actions"><button class="primary" id="run-demo-top" type="button">Run scripted proof</button><a class="mode-link" href="#demo">Open cockpit slice</a></div></section>
    <section class="section-band slide" data-slide="1" id="map"><div class="two"><div><span class="kicker">System map</span><h2>Every boundary is visible.</h2><p class="subhead">Deterministic telephony state, Pipecat media transport, local ASR, agent policy/tool control, operator steer, TTS fallback, and evaluation evidence are separate contracts.</p><svg class="arch" viewBox="0 0 980 380" role="img" aria-label="On-prem voice agent architecture"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#2457a6"/></marker></defs><rect class="nodeAccent" x="24" y="74" width="130" height="74" rx="8"/><text class="label" x="89" y="105" text-anchor="middle">Caller</text><text class="small" x="89" y="126" text-anchor="middle">SIP / browser</text><rect class="node" x="194" y="74" width="132" height="74" rx="8"/><text class="label" x="260" y="105" text-anchor="middle">Pipecat</text><text class="small" x="260" y="126" text-anchor="middle">transport</text><rect class="nodeWarn" x="366" y="74" width="132" height="74" rx="8"/><text class="label" x="432" y="105" text-anchor="middle">rtc-asr</text><text class="small" x="432" y="126" text-anchor="middle">Local STT v1</text><rect class="nodeAccent" x="538" y="74" width="144" height="74" rx="8"/><text class="label" x="610" y="105" text-anchor="middle">OpenClaw</text><text class="small" x="610" y="126" text-anchor="middle">agent harness</text><rect class="nodeWarn" x="722" y="74" width="112" height="74" rx="8"/><text class="label" x="778" y="105" text-anchor="middle">Kokoro</text><text class="small" x="778" y="126" text-anchor="middle">TTS</text><rect class="node" x="298" y="236" width="160" height="78" rx="8"/><text class="label" x="378" y="267" text-anchor="middle">Operator</text><text class="small" x="378" y="288" text-anchor="middle">approve / handoff</text><rect class="nodeAccent" x="536" y="236" width="158" height="78" rx="8"/><text class="label" x="615" y="267" text-anchor="middle">Proof bundle</text><text class="small" x="615" y="288" text-anchor="middle">events + latency</text><rect class="nodeAccent" x="748" y="236" width="160" height="78" rx="8"/><text class="label" x="828" y="267" text-anchor="middle">ASSERT eval</text><text class="small" x="828" y="288" text-anchor="middle">scorecard</text><path class="line" d="M154 111 H194"/><path class="line" d="M326 111 H366"/><path class="line" d="M498 111 H538"/><path class="line" d="M682 111 H722"/><path class="line" d="M610 148 V236"/><path class="line" d="M694 275 H748"/><path class="line" d="M458 275 H536"/><path class="line" d="M378 236 C412 184 496 154 538 126"/></svg></div><div class="grid" id="readiness"></div></div></section>
    <section class="section-band slide" data-slide="2" id="demo"><span class="kicker">Scripted cancellation rescue</span><h2>Run the operator-safe story end to end.</h2><div class="two"><div class="demo-shell"><div class="actions"><button class="primary" id="run-demo" type="button">Run scripted demo</button><button id="drill-tool" type="button" class="danger">Tool timeout drill</button><button id="drill-tts" type="button">TTS unavailable</button></div><div class="screen" id="demo-screen">Ready. Scripted mode needs no external credentials.</div></div><div class="timeline" id="timeline"></div></div></section>
    <section class="section-band slide" data-slide="3" id="agent"><span class="kicker">Agent harness</span><h2>Markdown brain blocks are part of the runtime story.</h2><div class="brain" id="brain"></div><div class="actions"><button id="preview-brain" type="button">Preview edits</button><button id="reset-brain" type="button">Reset</button></div></section>
    <section class="section-band slide" data-slide="4" id="proof"><span class="kicker">Evidence finish line</span><h2>The demo ends at proof, not speech.</h2><div class="two"><div class="grid" id="proof-cards"></div><pre class="proof-pre" id="proof-json">Run the scripted demo to preview the proof bundle and ASSERT handoff.</pre></div></section>
  </main>
  <script>window.__CLUECON__ = ${data};</script>
  <script>
    const data = window.__CLUECON__;
    const state = { slide: 0, proof: null, brain: JSON.parse(JSON.stringify(data.brainBlocks)) };
    function esc(value) { return String(value).replace(/[&<>\"]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"); }
    function renderReadiness() { document.getElementById("readiness").innerHTML = data.readiness.map(item => '<article class="card metric"><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><strong>' + esc(item.label) + '</strong><span class="muted">' + esc(item.detail) + '</span><span class="muted">' + esc(item.caveat) + '</span></article>').join(""); }
    function renderBrain() { document.getElementById("brain").innerHTML = state.brain.map((block, index) => '<article class="plain"><h3>' + esc(block.file) + '</h3><textarea data-brain="' + index + '">' + esc(block.summary) + '</textarea><span class="muted">Affects: ' + esc(block.affects.join(", ")) + '</span></article>').join(""); document.querySelectorAll("textarea[data-brain]").forEach(input => input.addEventListener("change", () => { state.brain[Number(input.dataset.brain)].summary = input.value; })); }
    function renderProofCards() { document.getElementById("proof-cards").innerHTML = data.proofPreview.includes.map(item => '<article class="card metric"><span class="muted">Proof field</span><strong>' + esc(item) + '</strong></article>').join(""); }
    function renderTimeline(call) { const events = call ? call.events.slice(-8) : []; document.getElementById("timeline").innerHTML = events.map(event => '<div class="event"><strong>' + esc(event.type) + '</strong><span class="muted">' + esc(JSON.stringify(event.detail)) + '</span></div>').join("") || '<div class="plain muted">Timeline will populate from the scripted call events.</div>'; }
    function renderSlides() { document.querySelectorAll("[data-slide]").forEach(el => el.classList.toggle("active", Number(el.dataset.slide) === state.slide)); }
    async function runDemo() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); document.getElementById("demo-screen").textContent = "Running scripted cancellation-rescue proof..."; try { const response = await fetch(data.routes.scriptedDemo, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/vertical-slice" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "demo failed"); state.proof = payload.proof; const transcript = payload.call.transcript.map(turn => turn.speaker + ": " + turn.text).join("\n"); document.getElementById("demo-screen").textContent = transcript; document.getElementById("proof-json").textContent = JSON.stringify({ compatibleRequest: data.proofPreview.compatibleRequest, proof: payload.proof }, null, 2); renderTimeline(payload.call); } catch (error) { document.getElementById("demo-screen").textContent = String(error.message || error); } finally { buttons.forEach(button => button.disabled = false); } }
    function previewBrain() { document.getElementById("proof-json").textContent = JSON.stringify({ previewOnly: true, activeBrainBlocks: state.brain, caveat: "Preview does not mutate the local runtime until an apply endpoint is intentionally added." }, null, 2); state.slide = ${mode === "present" ? 4 : 3}; renderSlides(); }
    function resetBrain() { state.brain = JSON.parse(JSON.stringify(data.brainBlocks)); renderBrain(); }
    function drill(kind) { const message = kind === "tool" ? "tool_timeout -> fail-closed human handoff; no improvised offer." : "tts_unavailable -> text/local-TTS fallback; Kokoro remains marked unavailable."; document.getElementById("demo-screen").textContent = message; document.getElementById("proof-json").textContent = JSON.stringify({ failureDrill: kind, honestState: message }, null, 2); }
    document.getElementById("run-demo").addEventListener("click", runDemo); document.getElementById("run-demo-top").addEventListener("click", runDemo); document.getElementById("drill-tool").addEventListener("click", () => drill("tool")); document.getElementById("drill-tts").addEventListener("click", () => drill("tts")); document.getElementById("preview-brain").addEventListener("click", previewBrain); document.getElementById("reset-brain").addEventListener("click", resetBrain); document.getElementById("next").addEventListener("click", () => { state.slide = Math.min(4, state.slide + 1); renderSlides(); }); document.getElementById("prev").addEventListener("click", () => { state.slide = Math.max(0, state.slide - 1); renderSlides(); }); document.addEventListener("keydown", event => { if (event.key === "ArrowRight" || event.key === "PageDown") { state.slide = Math.min(4, state.slide + 1); renderSlides(); } if (event.key === "ArrowLeft" || event.key === "PageUp") { state.slide = Math.max(0, state.slide - 1); renderSlides(); } });
    renderReadiness(); renderBrain(); renderProofCards(); renderTimeline(null); renderSlides();
  </script>
</body>
</html>`;
}
