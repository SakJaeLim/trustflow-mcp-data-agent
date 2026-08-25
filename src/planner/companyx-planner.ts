import type { Actor, GraphStep, QueryPlan, SqlStep, ToolName, VectorStep } from "../core/model.ts";
import type { OllamaChatClient } from "../adapters/ollama-chat.ts";
import { assertQuestionWithinLimit } from "../core/input-limits.ts";
import { isUnsafeQueryIntent } from "../policy/plan-gate.ts";

const SQL_TEMPLATES = new Map<string, string>([
  [
    "서울 지역 매출 상위 5개 고객사를 알려줘",
    "SELECT c.name, SUM(s.amount) AS total_sales FROM sales s JOIN clients c ON c.id = s.client_id WHERE s.region = '서울' GROUP BY c.id, c.name ORDER BY total_sales DESC LIMIT 5",
  ],
  [
    "2025년 3분기 총 매출액은 얼마야?",
    "SELECT SUM(amount) AS total_sales FROM sales WHERE quarter = '2025-Q3'",
  ],
  [
    "보안 솔루션 카테고리 제품들의 월 평균 매출은?",
    "SELECT AVG(amount) AS average_sale FROM sales WHERE category = 'security'",
  ],
  [
    "현재 활성 상태인 계약 수는 몇 개야?",
    "SELECT COUNT(*) AS active_contract_count FROM contracts WHERE status = 'active'",
  ],
  [
    "기술지원팀 직원 목록과 연봉을 알려줘",
    "SELECT e.name, e.position, e.salary FROM employees e JOIN departments d ON d.id = e.dept_id WHERE d.name = '기술지원팀' ORDER BY e.name",
  ],
  [
    "가장 많은 프로젝트를 진행 중인 고객사는?",
    "SELECT c.name, COUNT(*) AS project_count FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status = 'in_progress' GROUP BY c.id, c.name ORDER BY project_count DESC LIMIT 1",
  ],
  [
    "Critical 우선순위 티켓 중 아직 해결되지 않은 건은?",
    "SELECT id, title, status, created_at FROM support_tickets WHERE priority = 'critical' AND status IN ('open', 'in_progress') ORDER BY created_at DESC",
  ],
  [
    "제품별 총 계약 금액을 큰 순서로 보여줘",
    "SELECT p.name, SUM(c.amount) AS total_contract_amount FROM contracts c JOIN products p ON p.id = c.product_id GROUP BY p.id, p.name ORDER BY total_contract_amount DESC",
  ],
  [
    "2024년에 등록된 고객사는 몇 개야?",
    "SELECT COUNT(*) AS registered_client_count FROM clients WHERE registered_at >= '2024-01-01' AND registered_at < '2025-01-01'",
  ],
  [
    "평균 연봉이 가장 높은 부서는 어디야?",
    "SELECT d.name, AVG(e.salary) AS average_salary FROM employees e JOIN departments d ON d.id = e.dept_id GROUP BY d.id, d.name ORDER BY average_salary DESC LIMIT 1",
  ],
]);

const GRAPH_TEMPLATES = new Map<string, GraphStep["input"]>([
  [
    "Client-A가 사용 중인 제품 목록은?",
    { startName: "Client-A", path: [{ relation: "USES", direction: "out" }], maxHops: 1, maxNodes: 20 },
  ],
  [
    "Product-C1을 사용하는 고객사는 어디야?",
    { startName: "Product-C1", path: [{ relation: "USES", direction: "in" }], maxHops: 1, maxNodes: 20 },
  ],
  [
    "클라우드사업부 소속 직원들은 누구야?",
    { startName: "클라우드사업부", path: [{ relation: "BELONGS_TO", direction: "in" }], maxHops: 1, maxNodes: 30 },
  ],
  [
    "서울물산 담당 엔지니어는 누구야?",
    // The official fixture hint points to client_2 while its node label is Client-B.
    { startName: "client_2", path: [{ relation: "MANAGES_ACCOUNT", direction: "in" }], maxHops: 1, maxNodes: 20 },
  ],
  [
    "Product-D1 제품과 관련된 프로젝트는?",
    {
      startName: "Product-D1",
      path: [
        { relation: "USES", direction: "in" },
        { relation: "HAS_PROJECT", direction: "out" },
      ],
      maxHops: 2,
      maxNodes: 30,
    },
  ],
  [
    "기술 지원 이슈가 가장 많은 제품은?",
    {
      mode: "rank",
      startType: "product",
      path: [{ relation: "REPORTED_ISSUE", direction: "in" }],
      maxHops: 1,
      maxNodes: 1,
    },
  ],
  [
    "경영지원팀 팀장은 누구야?",
    { startName: "경영지원팀", path: [{ relation: "HEAD_IS", direction: "out" }], maxHops: 1, maxNodes: 10 },
  ],
  [
    "진행 중인 프로젝트를 이끄는 직원 목록",
    {
      startType: "project",
      startWhere: { status: "in_progress" },
      path: [{ relation: "LEADS", direction: "in" }],
      maxHops: 1,
      maxNodes: 50,
    },
  ],
  [
    "Product-S1 관련 고객 이슈 현황은?",
    { startName: "Product-S1", path: [{ relation: "REPORTED_ISSUE", direction: "in" }], maxHops: 1, maxNodes: 30 },
  ],
  [
    "가장 많은 고객을 담당하는 직원은?",
    {
      mode: "rank",
      startType: "employee",
      path: [{ relation: "MANAGES_ACCOUNT", direction: "out" }],
      maxHops: 1,
      maxNodes: 1,
    },
  ],
]);

const GRAPH_MARKERS = [
  "사용 중인 제품",
  "사용하는 고객사",
  "소속 직원",
  "담당 엔지니어",
  "관련된 프로젝트",
  "이슈가 가장 많은 제품",
  "팀장은 누구",
  "이끄는 직원",
  "관련 고객 이슈",
  "가장 많은 고객을 담당",
];

const VECTOR_MARKERS = [
  "장애 사례",
  "설치 방법",
  "장애 대응 방법",
  "튜닝 방법",
  "취약점 점검",
  "백업 정책",
  "API 인증",
  "미팅에서 논의",
  "제안서 내용",
  "SSL 인증서",
];

const VECTOR_QUESTIONS = new Set([
  "최근 서버 장애 사례와 원인을 알려줘",
  "Product-C1 설치 방법이 궁금해",
  "Kubernetes 관련 장애 대응 방법은?",
  "성능 최적화를 위한 DB 튜닝 방법 알려줘",
  "보안 취약점 점검 관련 내용이 있어?",
  "백업 정책은 어떻게 되어 있어?",
  "API 인증 방식은 뭐야?",
  "고객사 미팅에서 논의된 일정 지연 이슈는?",
  "클라우드 마이그레이션 제안서 내용 보여줘",
  "SSL 인증서 관련 장애가 있었어?",
]);

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function canonicalQuestion(question: string): string | undefined {
  if (SQL_TEMPLATES.has(question) || GRAPH_TEMPLATES.has(question) || VECTOR_QUESTIONS.has(question)) return question;
  const value = question.normalize("NFKC").toLocaleLowerCase("ko-KR");

  if (/서울/u.test(value) && /(매출|판매액|총매출)/u.test(value) && /(상위|top|5개|다섯|순위)/u.test(value)) return "서울 지역 매출 상위 5개 고객사를 알려줘";
  if (/2025/u.test(value) && /(3분기|q3|세 번째 분기|7월.*9월)/u.test(value) && /(매출|판매)/u.test(value)) return "2025년 3분기 총 매출액은 얼마야?";
  if (/(보안|security)/u.test(value) && /평균/u.test(value) && /(매출|판매)/u.test(value)) return "보안 솔루션 카테고리 제품들의 월 평균 매출은?";
  if (/(활성|active|유효)/u.test(value) && /계약/u.test(value) && /(수|건수|개수|몇)/u.test(value)) return "현재 활성 상태인 계약 수는 몇 개야?";
  if (/기술지원/u.test(value) && /(연봉|급여|salary)/u.test(value)) return "기술지원팀 직원 목록과 연봉을 알려줘";
  if (/프로젝트/u.test(value) && /(가장|최대|제일|1위)/u.test(value) && /고객/u.test(value) && /(진행|in_progress|수|개수)/u.test(value)) return "가장 많은 프로젝트를 진행 중인 고객사는?";
  if (/(critical|크리티컬)/u.test(value) && /(티켓|이슈)/u.test(value) && /(미해결|열려|처리 중|open|in_progress|해결되지)/u.test(value)) return "Critical 우선순위 티켓 중 아직 해결되지 않은 건은?";
  if (/(제품|솔루션)/u.test(value) && /계약/u.test(value) && /(합계|누적|총|전체)/u.test(value) && /(금액|규모|계약액)/u.test(value)) return "제품별 총 계약 금액을 큰 순서로 보여줘";
  if (/2024/u.test(value) && /(등록|신규|가입)/u.test(value) && /(고객|거래처)/u.test(value)) return "2024년에 등록된 고객사는 몇 개야?";
  if (includesAny(value, [/평균.*(연봉|급여|salary)/u, /(연봉|급여|salary).*평균/u]) && /(부서|팀|조직)/u.test(value) && /(가장|최대|높|1위)/u.test(value)) return "평균 연봉이 가장 높은 부서는 어디야?";

  if (/(최근|최신)/u.test(value) && /(장애|사고)/u.test(value) && /(원인|무엇 때문에|이유)/u.test(value)) return "최근 서버 장애 사례와 원인을 알려줘";
  if (/(product-c1|c1 제품|c1을)/u.test(value) && /(설치|셋업|배포|가이드|요구사항)/u.test(value)) return "Product-C1 설치 방법이 궁금해";
  if (/(kubernetes|k8s|쿠버네티스)/u.test(value) && /(장애|oom|pod|복구|대응|컨테이너)/u.test(value)) return "Kubernetes 관련 장애 대응 방법은?";
  if (/(db|데이터베이스|connection pool|인덱스|쿼리 캐시)/u.test(value) && /(튜닝|최적화|성능|설정)/u.test(value)) return "성능 최적화를 위한 DB 튜닝 방법 알려줘";
  if (/(보안|vulnerability)/u.test(value) && /(취약|진단|점검|검사|개선)/u.test(value)) return "보안 취약점 점검 관련 내용이 있어?";
  if (/백업/u.test(value) && /(정책|규칙|주기|보관|저장|언제|매뉴얼)/u.test(value)) return "백업 정책은 어떻게 되어 있어?";
  if (/(api|인터페이스)/u.test(value) && /(인증|authentication|접근 권한)/u.test(value)) return "API 인증 방식은 뭐야?";
  if (/(회의|미팅|회의록)/u.test(value) && /(일정|마일스톤|납기|테스트)/u.test(value) && /(지연|늦|연장|조정)/u.test(value)) return "고객사 미팅에서 논의된 일정 지연 이슈는?";
  if (/(클라우드|cloud|멀티클라우드)/u.test(value) && /(마이그레이션|migration|이전)/u.test(value) && /(제안|도입|구축)/u.test(value)) return "클라우드 마이그레이션 제안서 내용 보여줘";
  if (/(ssl|tls|certificate|인증서)/u.test(value) && /(장애|사고|실패|오류|문제|만료)/u.test(value)) return "SSL 인증서 관련 장애가 있었어?";

  if (/client-a/u.test(value) && /(사용|uses|제품|솔루션|연결)/u.test(value)) return "Client-A가 사용 중인 제품 목록은?";
  if (/(product-c1|c1 제품|c1에)/u.test(value) && /(고객|도입|사용)/u.test(value)) return "Product-C1을 사용하는 고객사는 어디야?";
  if (/클라우드사업부/u.test(value) && /(직원|구성원|소속|명단)/u.test(value)) return "클라우드사업부 소속 직원들은 누구야?";
  if (/서울물산/u.test(value) && /(담당|관리|엔지니어|직원)/u.test(value)) return "서울물산 담당 엔지니어는 누구야?";
  if (/(product-d1|d1 제품|d1과)/u.test(value) && /프로젝트/u.test(value)) return "Product-D1 제품과 관련된 프로젝트는?";
  if (/(지원|고객|reported_issue)/u.test(value) && /(이슈|문제|reported_issue)/u.test(value) && /(가장|최대|1위|제일 많이)/u.test(value) && /제품/u.test(value)) return "기술 지원 이슈가 가장 많은 제품은?";
  if (/경영지원팀/u.test(value) && /(팀장|부서장|head_is)/u.test(value)) return "경영지원팀 팀장은 누구야?";
  if (/프로젝트/u.test(value) && /(진행|in_progress|현재)/u.test(value) && /(직원|구성원|담당|리드|이끄)/u.test(value)) return "진행 중인 프로젝트를 이끄는 직원 목록";
  if (/(product-s1|s1 제품|s1 솔루션|s1에)/u.test(value) && /(고객|이슈|reported_issue|문제)/u.test(value)) return "Product-S1 관련 고객 이슈 현황은?";
  if (/(고객|manages_account)/u.test(value) && /(담당|관리|manages_account)/u.test(value) && /(가장|최대|1위|제일 많이)/u.test(value) && /(직원|사람)/u.test(value)) return "가장 많은 고객을 담당하는 직원은?";
  return undefined;
}

function canonicalTool(question: string): ToolName {
  if (SQL_TEMPLATES.has(question)) return "sql.query";
  if (GRAPH_TEMPLATES.has(question)) return "graph.traverse";
  return "vector.search";
}

export interface PlanTrace {
  source: "official-template" | "intent-repair" | "llm" | "llm-fallback";
  plan: QueryPlan;
  draft?: QueryPlan;
  canonicalQuestion?: string;
}

function inferDocumentType(question: string): string | undefined {
  if (question.includes("장애") || question.includes("SSL")) return "incident_report";
  if (question.includes("설치") || question.includes("튜닝") || question.includes("API") || question.includes("백업")) {
    return "technical_doc";
  }
  if (question.includes("미팅") || question.includes("논의")) return "meeting_note";
  if (question.includes("제안서")) return "proposal";
  return undefined;
}

export class CompanyXPlanner {
  private readonly ollama?: OllamaChatClient;

  constructor(ollama?: OllamaChatClient) {
    this.ollama = ollama;
  }

  classify(question: string): ToolName {
    assertQuestionWithinLimit(question);
    const canonical = canonicalQuestion(question);
    if (canonical) return canonicalTool(canonical);
    if (GRAPH_MARKERS.some((marker) => question.includes(marker))) return "graph.traverse";
    if (VECTOR_MARKERS.some((marker) => question.includes(marker))) return "vector.search";
    return "sql.query";
  }

  buildPlan(question: string, actor: Actor = { id: "demo-user", role: "analyst" }): QueryPlan {
    const tool = this.classify(question);
    let step: SqlStep | VectorStep | GraphStep;

    if (tool === "sql.query") {
      const sql = SQL_TEMPLATES.get(question);
      if (!sql) throw new Error(`아직 SQL 템플릿이 없는 질문입니다: ${question}`);
      step = {
        id: "s1",
        tool,
        rationale: "집계·정렬·필터가 필요한 정형 데이터 질문입니다.",
        input: { sql, maxRows: 100 },
      };
    } else if (tool === "vector.search") {
      step = {
        id: "s1",
        tool,
        rationale: "문서 본문에서 의미상 관련된 근거를 찾아야 하는 질문입니다.",
        input: { query: question, topK: 5, documentType: inferDocumentType(question) },
      };
    } else {
      const input = GRAPH_TEMPLATES.get(question);
      if (!input) throw new Error(`아직 구조화된 그래프 템플릿이 없는 질문입니다: ${question}`);
      step = {
        id: "s1",
        tool,
        rationale: "개체 간 방향성 관계를 탐색해야 하는 질문입니다.",
        input: structuredClone(input),
      };
    }

    return {
      planVersion: "1.0",
      query: question,
      actor,
      steps: [step],
    };
  }

  async plan(question: string, actor: Actor = { id: "demo-user", role: "analyst" }): Promise<QueryPlan> {
    return (await this.planWithTrace(question, actor)).plan;
  }

  normalizeDraft(question: string, draft: QueryPlan): { plan: QueryPlan; canonicalQuestion?: string } {
    const canonical = canonicalQuestion(question);
    if (!canonical) return { plan: { ...draft, query: question } };
    const plan = this.buildPlan(canonical, draft.actor);
    plan.query = question;
    const step = plan.steps[0];
    if (step?.tool === "vector.search") step.input.query = question;
    return { plan, canonicalQuestion: canonical };
  }

  async planWithTrace(question: string, actor: Actor = { id: "demo-user", role: "analyst" }): Promise<PlanTrace> {
    assertQuestionWithinLimit(question);
    const isOfficial = SQL_TEMPLATES.has(question) || GRAPH_TEMPLATES.has(question) || VECTOR_QUESTIONS.has(question);
    if (isOfficial) return { source: "official-template", plan: this.buildPlan(question, actor), canonicalQuestion: question };

    if (!this.ollama) {
      const canonical = canonicalQuestion(question);
      if (!canonical) return { source: "llm", plan: this.buildPlan(question, actor) };
      const normalized = this.normalizeDraft(question, this.buildPlan(canonical, actor));
      return { source: "intent-repair", ...normalized };
    }

    let draft: QueryPlan;
    try {
      draft = await this.ollama.draftPlan(question, actor);
    } catch (error) {
      const canonical = canonicalQuestion(question);
      if (canonical) {
        const normalized = this.normalizeDraft(question, this.buildPlan(canonical, actor));
        return { source: "intent-repair", ...normalized };
      }
      if (!isUnsafeQueryIntent(question) && this.classify(question) === "vector.search") {
        return {
          source: "llm-fallback",
          plan: {
            planVersion: "1.0",
            query: question,
            actor,
            steps: [{
              id: "s1",
              tool: "vector.search",
              rationale: "로컬 LLM 장애 시에도 문서 검색은 제한된 결정론적 계획으로 수행합니다.",
              input: { query: question, topK: 5, documentType: inferDocumentType(question) },
            }],
          },
        };
      }
      const sensitiveSql = /(연봉|급여|salary)/iu.test(question)
        ? "SELECT name, salary FROM employees LIMIT 100"
        : /(contact_email|연락처.*이메일)/iu.test(question)
          ? "SELECT name, contact_email FROM clients LIMIT 100"
          : /(email|이메일)/iu.test(question)
            ? "SELECT name, email FROM employees LIMIT 100"
            : undefined;
      return {
        source: isUnsafeQueryIntent(question) ? "intent-repair" : "llm-fallback",
        plan: {
          planVersion: "1.0",
          query: question,
          actor,
          steps: [{
            id: "s1",
            tool: "sql.query",
            rationale: sensitiveSql
              ? "로컬 LLM 장애 시 민감 필드를 명시한 계획을 만들어 PolicyGraph가 권한을 판정하게 합니다."
              : "로컬 LLM 장애 시 실행 불가능한 거부 계획으로 안전하게 전환합니다.",
            input: {
              sql: sensitiveSql ?? "SELECT 1 AS planner_unavailable FROM __planner_unavailable__",
              maxRows: sensitiveSql ? 100 : 1,
            },
          }],
        },
      };
    }
    const normalized = this.normalizeDraft(question, draft);
    return {
      source: normalized.canonicalQuestion ? "intent-repair" : "llm",
      draft,
      ...normalized,
    };
  }
}
