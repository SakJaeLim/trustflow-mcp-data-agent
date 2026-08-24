const $ = (selector) => document.querySelector(selector);
const state = { lastQuestion: "" };

function setText(selector, value) { $(selector).textContent = String(value); }
function clear(node) { while (node.firstChild) node.firstChild.remove(); }
function classFor(value) { return `state-${String(value).toLowerCase()}`; }

function status(selector, value) {
  const node = $(selector);
  node.className = `${classFor(value)} pulse`;
  node.textContent = String(value).toUpperCase();
  setTimeout(() => node.classList.remove("pulse"), 380);
}

function renderExamples(items) {
  const labels = { nl2sql: "NL2SQL · 10", vector_search: "VECTOR · 10", knowledge_graph: "GRAPH · 10" };
  const list = $("#question-list");
  clear(list);
  Object.keys(labels).forEach((tool) => {
    const section = document.createElement("section");
    section.className = "question-group";
    const heading = document.createElement("h2");
    heading.textContent = labels[tool];
    section.append(heading);
    items.filter((item) => item.tool === tool).forEach((item) => {
      const button = document.createElement("button");
      button.className = "question-item";
      button.textContent = item.q;
      button.addEventListener("click", () => {
        $("#question").value = item.q;
        document.querySelectorAll(".question-item").forEach((node) => node.classList.remove("active"));
        button.classList.add("active");
      });
      section.append(button);
    });
    list.append(section);
  });
}

function renderResult(result) {
  status("#plan-state", "typed");
  status("#policy-state", result.policy.decision);
  status("#execution-state", result.status);
  setText("#evidence-state", result.evidence.filter((item) => item.kind !== "policy").length);
  const duration = result.executions.reduce((sum, item) => sum + item.durationMs, 0);
  setText("#latency", `${duration.toFixed(2)} ms · ${result.runId.slice(0, 8)}`);
  setText("#decision-badge", result.policy.decision);
  $("#decision-badge").className = classFor(result.policy.decision);
  $("#plan-json").textContent = JSON.stringify(result.policy.executablePlan ?? result.policy.originalPlan, null, 2);

  const answer = $("#answer");
  answer.classList.remove("empty");
  if (result.answer?.text) answer.textContent = result.answer.text;
  else if (result.status === "approval_required") answer.textContent = "민감 필드 조회입니다. 신뢰된 서버 측 승인 워크플로가 필요합니다.";
  else if (result.status === "denied") answer.textContent = "TrustFlow의 PolicyGraph가 실행 전에 요청을 차단했습니다.";
  else answer.textContent = "실행 결과를 생성하지 못했습니다.";
  setText("#verification", result.answer?.verified ? "근거 연결 검증됨" : "실행 안 됨");

  const policies = $("#policy-list");
  clear(policies);
  const ids = result.policy.policyGraph.matchedPolicyIds;
  if (!ids.length) {
    const item = document.createElement("span"); item.className = "muted"; item.textContent = "위반 정책 없음"; policies.append(item);
  } else ids.forEach((id) => { const item = document.createElement("span"); item.className = "policy-chip"; item.textContent = id; policies.append(item); });

  const findings = $("#finding-list");
  clear(findings);
  const messages = [
    ...result.policy.findings.map((item) => ({ text: `${item.code} · ${item.message}`, severity: item.severity })),
    ...result.policy.repairs.map((item) => ({ text: `${item.code} · ${item.description}`, severity: "warning" })),
  ];
  if (!messages.length) { const item = document.createElement("span"); item.className = "muted"; item.textContent = "검증 통과"; findings.append(item); }
  else messages.forEach((message) => { const item = document.createElement("div"); item.className = `finding ${message.severity}`; item.textContent = message.text; findings.append(item); });

  const evidenceList = $("#evidence-list");
  clear(evidenceList);
  result.evidence.filter((item) => item.kind !== "policy").forEach((evidence, index) => {
    const details = document.createElement("details"); details.className = "evidence-item"; details.style.animationDelay = `${index * 45}ms`;
    const summary = document.createElement("summary");
    const kind = document.createElement("span"); kind.className = "evidence-kind"; kind.textContent = evidence.kind.toUpperCase();
    const source = document.createElement("span"); source.className = "evidence-source"; source.textContent = evidence.source;
    const score = document.createElement("span"); score.className = "evidence-score"; score.textContent = evidence.score == null ? evidence.evidenceId.slice(0, 13) : evidence.score.toFixed(4);
    const payload = document.createElement("pre"); payload.textContent = JSON.stringify(evidence.payload, null, 2);
    summary.append(kind, source, score); details.append(summary, payload); evidenceList.append(details);
  });
}

async function request(path, payload) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function run() {
  const button = $("#run");
  state.lastQuestion = $("#question").value.trim();
  button.disabled = true; button.firstChild.textContent = "검증 중 ";
  try { renderResult(await request("/api/ask", { question: state.lastQuestion })); }
  catch (error) { $("#answer").textContent = error.message; status("#execution-state", "failed"); }
  finally { button.disabled = false; button.firstChild.textContent = "계획 검증 후 실행 "; }
}

$("#run").addEventListener("click", () => run());
$("#question").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") run(); });
document.querySelectorAll("[data-scenario]").forEach((button) => button.addEventListener("click", async () => {
  try { renderResult(await request("/api/scenario", { id: button.dataset.scenario })); }
  catch (error) { $("#answer").textContent = error.message; }
}));

Promise.all([
  fetch("/api/health").then((response) => response.json()),
  fetch("/api/examples").then((response) => response.json()),
]).then(([health, examples]) => {
  $(".health").classList.add("ok");
  setText("#health-label", `${health.status} · 3 mcp tools`);
  setText("#actor-role", health.actorRole);
  renderExamples(examples);
}).catch(() => setText("#health-label", "runtime unavailable"));
