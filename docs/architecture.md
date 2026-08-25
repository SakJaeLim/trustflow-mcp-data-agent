# TrustFlow MCP 데이터 에이전트 아키텍처

## 1. 설계 목표

TrustFlow는 Company-X의 정형 데이터, 비정형 문서, 관계 데이터를 하나의 MCP 서버로 제공하며, 내부 PolicyGraph가 실행 전에 정책을 판정하고 실행 후 근거와 감사 기록을 남깁니다.

핵심 품질 목표는 다음 네 가지입니다.

1. 필수 도구 완수: NL2SQL, 벡터 검색, 지식그래프를 실제 MCP 도구로 제공
2. 실행 안전성: 비신뢰 계획을 ALLOW, REPAIR, APPROVAL_REQUIRED, DENY로 판정
3. 검증 가능성: 답변의 각 claim을 evidenceId로 추적
4. 재현 가능성: 인터넷이 없어도 공식 30문항을 실행하는 기준선 제공

P0의 비목표는 범용 질의 대응, 멀티에이전트, 고가용성 클러스터, 운영용 인증·관리자 UI입니다.

## 2. 시스템 경계

~~~mermaid
flowchart TB
    Host[MCP Host / Local LLM]
    Server[air MCP Server]
    Planner[Company-X Planner]
    Gate[PolicyGraph PlanGate]
    Orchestrator[PolicyGraph Orchestrator]
    SQL[SQL Executor]
    Vector[Vector Executor]
    Graph[Graph Executor]
    PG[(PostgreSQL + pgvector)]
    Docs[(40 Markdown Documents)]
    KG[(133 Nodes / 354 Edges)]
    Composer[Evidence Composer]
    Ledger[(Hash-chain JSONL Ledger)]

    Host --> Server
    Server --> Planner
    Planner --> Gate
    Gate --> Orchestrator
    Orchestrator --> SQL
    Orchestrator --> Vector
    Orchestrator --> Graph
    SQL --> PG
    Vector --> PG
    Vector --> Docs
    Graph --> KG
    SQL --> Composer
    Vector --> Composer
    Graph --> Composer
    Gate --> Ledger
    Composer --> Ledger
    Composer --> Server
    Server --> Host
~~~

외부 네트워크는 런타임 필수 경로가 아닙니다. 공식 데이터 다운로드와 Ollama 모델 최초 설치만 별도 준비 단계입니다.

## 3. 실행 순서

~~~mermaid
sequenceDiagram
    participant H as MCP Host
    participant M as MCP Tool
    participant P as Planner
    participant G as PlanGate
    participant X as Executor
    participant C as Evidence Composer
    participant L as Audit Ledger

    H->>M: 자연어 질문
    M->>P: 질문 + 서버 고정 역할
    P-->>M: QueryPlan
    M->>G: 비신뢰 계획 검증
    alt DENY
        G-->>M: DENY + findings
        M->>L: 거부 기록
    else APPROVAL_REQUIRED
        G-->>M: 승인 사유
        M->>L: 승인 대기 기록
    else REPAIR 또는 ALLOW
        G-->>M: executablePlan
        M->>L: started + 계획 해시 기록
        M->>X: 등록된 단계만 실행
        X-->>C: 표/문서/그래프 근거
        C-->>M: claim + evidenceId + citation
        M->>L: 종료 상태 + 실행 + 근거 해시
    end
    M-->>H: 구조화 결과
~~~

## 4. 핵심 계약

### QueryPlan

QueryPlan은 자연어와 실행 사이의 명시적 경계입니다.

~~~json
{
  "planVersion": "1.0",
  "query": "2025년 3분기 총 매출액은 얼마야?",
  "actor": {
    "id": "mcp-user",
    "role": "analyst"
  },
  "steps": [
    {
      "id": "s1",
      "tool": "sql.query",
      "rationale": "정형 집계 질문",
      "input": {
        "sql": "SELECT SUM(amount) AS total_sales FROM sales WHERE quarter = '2025-Q3'",
        "maxRows": 100
      }
    }
  ]
}
~~~

실행기는 QueryPlan 바깥의 임의 명령을 받지 않습니다.

### PolicyDecision

PolicyDecision에는 원본 계획, 실행 가능 계획, finding, repair, 승인 사유, 평가·일치 정책 ID가 들어갑니다.

| 결정 | executablePlan | 실행 |
|---|---|---|
| ALLOW | 원본과 동등 | 즉시 실행 |
| REPAIR | 정책이 보정한 계획 | 보정 계획 실행 |
| APPROVAL_REQUIRED | 존재 | 승인 전 중지 |
| DENY | 없음 | 실행 금지 |

### EvidenceItem

실행 결과는 단순 문자열이 아니라 근거 객체입니다.

- table: 실행 SQL, 행 수, 반환 행
- passage: 문서 ID, 제목, 점수, 발췌문
- graph_path: 시작 노드, 경로, 관계, 결과 노드 또는 순위
- policy: 판정, finding, repair, 승인 사유

AnswerEnvelope의 모든 claim은 정확히 하나의 알려진 evidenceId를 참조해야 합니다. 표의 한 행, 문서 passage 하나, 그래프 경로·순위·노드 하나를 원자적 근거로 검증하며, 서로 다른 근거의 사실을 한 claim으로 조합하거나 정확한 수치·단위·문서 발췌가 일치하지 않으면 모델 출력을 폐기하고 결정적 답변으로 대체합니다.

## 5. 정책 그래프

실행 정책은 src/policy/catalog.ts의 기계 판정 목록과 policy/policy-graph.ttl의 RDF/SHACL 표현을 함께 사용합니다.

| 정책군 | 대표 제약 |
|---|---|
| Plan | 1~6개 등록 단계 |
| Tool | SQL, Vector, Graph 실행기만 허용 |
| SQL | 단일 SELECT, 8개 업무 테이블, 명시 열, 별칭·USING·cross join 우회 차단, 최대 100행 |
| Sensitive | viewer 거부, analyst 승인 필요, HR/admin 허용 |
| Vector | 1~10개 근거 |
| Graph | 허용 관계, 최대 2홉, 최대 50개 노드 |
| Audit | 실행 전 started와 모든 종료 상태를 해시 체인 원장에 기록 |
| Network | 런타임 도구의 외부 네트워크 의존 금지 |

SQL 검사는 `pgsql-ast-parser`가 만든 PostgreSQL AST를 재귀 순회합니다. 단일 읽기 문장, 8개 업무 테이블·허용 열, 비재귀 CTE, 함수, 잠금, 서브쿼리와 whole-row projection을 확인합니다. 민감 열의 이름을 감추는 base-table 열 별칭 목록과 `JOIN ... USING`, cross join, 3개를 초과한 물리 관계 참조도 실행 전에 차단하고, 다음 방어층을 함께 적용합니다.

- policygraph_reader에 8개 업무 테이블과 내부 `document_chunks`의 SELECT만 명시적으로 부여하고, NL2SQL 허용 목록에서는 `document_chunks` 제외
- reader 역할의 superuser·DB/역할 생성·상속·복제·RLS 우회 권한 제거, 소유 객체·예상 밖 역할 소속 금지, 연결 수 5 제한
- PostgreSQL READ ONLY 트랜잭션
- statement_timeout 5초
- 바깥 래퍼 쿼리로 결과 최대 100행 강제

## 6. 감사 원장

각 실행은 도구 호출 전에 `started` 레코드를 먼저 내구성 있게 기록하고, 실행 후 `executed`, `denied`, `approval_required`, `failed` 중 하나의 종료 레코드를 추가합니다. 각 JSONL 레코드는 다음 무결성 필드를 갖습니다.

- sequence
- previousRecordHash
- recordHash
- originalPlanHash
- executablePlanHash
- 원문 대신 도메인 분리 SHA-256 queryDigest
- findingCodes와 repairCodes
- evidenceIds와 도구 호출 시간
- 승인자 식별자
- recordSignature

recordHash는 현재 레코드의 모든 필드와 previousRecordHash를 정규화해 SHA-256으로 계산하고, 각 레코드는 HMAC-SHA-256으로 서명합니다. 한 레코드가 바뀌면 해시·서명이 깨지고, 레코드 삽입·삭제·순서 변경은 다음 링크 또는 sequence 검증에서 드러납니다. 원장 64 MiB, 50,000개 레코드, 레코드당 64 KiB 예산을 넘으면 새 실행을 거부합니다. 여러 프로세스는 원자적 잠금 파일로 append를 직렬화하며, 잠금은 단순 경과 시간만으로 삭제하지 않고 손상된 기존 원장에는 새 레코드를 추가하지 않습니다. 감사 서명 키와 체크포인트 경로가 없으면 모든 런타임 모드가 fail closed 됩니다.

최종 sequence와 recordHash도 별도 파일에 HMAC 서명해 임시 파일 fsync 후 원자적으로 교체합니다. 검증 시 체크포인트가 현재 원장의 정확한 head가 아니면 과거에 유효했던 체크포인트도 거부합니다. 체크포인트와 원장을 서로 독립된 보호 영역에 두면 한쪽만 삭제·truncate하거나 과거 상태로 되돌리는 조작을 탐지할 수 있습니다. 원장과 체크포인트를 함께 삭제하거나 함께 교체하는 공격은 로컬 파일 경계 밖이며, 운영 단계에서는 체크포인트를 WORM 또는 외부 검증 저장소로 옮겨야 합니다.

## 7. 데이터 저장과 검색

### 관계형 데이터

PostgreSQL 16의 공식 8개 테이블을 사용합니다. MCP 런타임은 읽기 전용 계정으로 접속합니다.

원본 Company-X ZIP의 고정 SHA-256은 설치·런타임·평가·문서 적재에서 반복 검증됩니다. 추출 디렉터리는 공식 manifest와 파일 수·경로·크기·해시가 정확히 일치해야 하며, PostgreSQL 새 볼륨은 schema/data SQL seed 해시 검증이 통과해야만 초기화됩니다. 모든 근거에는 검증된 dataset SHA-256이 함께 기록됩니다.

### 문서 데이터

두 가지 모드를 제공합니다.

| 모드 | 목적 | 구현 |
|---|---|---|
| local | 테스트·오프라인 재현 | 한국어 단어와 2·3그램을 768차원에 해싱 |
| pgvector | 대회 운영 데모 | Ollama nomic-embed-text + vector(768) + HNSW |

local 모드는 외부 모델 없이 결정적이지만 의미 임베딩 모델의 품질을 대표하지 않습니다.

### 지식그래프

공식 nodes.json과 edges.json은 크기·노드/간선 수·속성 크기·ID/참조 무결성을 검증한 뒤 메모리에 로드합니다. outgoing/incoming 인접 인덱스로 관계 방향, 최대 홉, 최대 시작점·결과 노드 수를 QueryPlan 예산 안에서 탐색합니다. 운영 확장 시 그래프 DB 또는 PostgreSQL 관계 테이블로 교체할 수 있습니다.

## 8. 런타임 프로필

| 항목 | offline | postgres/local | postgres/pgvector |
|---|---|---|---|
| SQL | 메모리 SQLite | PostgreSQL | PostgreSQL |
| 문서 | 로컬 기준선 | 로컬 기준선 | Ollama + pgvector |
| 그래프 | JSON 메모리 | JSON 메모리 | JSON 메모리 |
| 인터넷 | 불필요 | 불필요 | 최초 모델 설치만 필요 |
| 용도 | CI·평가 | DB 통합 검증 | 대회 데모 |

## 9. 실패 의미

- denied: 정책이 명시적으로 실행을 거부
- approval_required: 승인 정보가 없어 실행 보류
- failed: 허용된 실행 중 어댑터·데이터·서비스 오류 발생
- executed: 모든 단계 실행 및 근거 수집 완료

실패도 감사 원장에 기록되며, 일부 단계가 끝난 뒤 오류가 난 경우 완료된 실행 근거와 오류 근거를 함께 보존합니다.

## 10. 주요 소스 매핑

| 책임 | 파일 |
|---|---|
| 계약 | src/core/model.ts |
| 계획기 | src/planner/companyx-planner.ts |
| 정책 판정 | src/policy/plan-gate.ts |
| 정책 카탈로그 | src/policy/catalog.ts |
| 오케스트레이션 | src/orchestrator.ts |
| 근거 답변 | src/evidence/composer.ts |
| 감사 원장 | src/evidence/ledger.ts |
| MCP | src/mcp/server.ts |
| PostgreSQL | src/adapters/postgres.ts |
| pgvector | src/adapters/pgvector-search.ts |
| Ollama 임베딩 | src/adapters/ollama-embedder.ts |
| Ollama 계획·답변 | src/adapters/ollama-chat.ts |
| 그래프 | src/tools/graph-store.ts |

## 11. 알려진 제한

1. 공식 30문항은 결정적 템플릿으로 계획하며 자유 표현은 선택형 Gemma 4로 처리합니다. 모델 장애 시 알려진 문서 질의만 bounded 검색으로 전환하고 그 밖의 미확인 계획은 fail-closed 처리합니다. 이는 범용 NL2SQL 정확도를 보장하지 않습니다.
2. 로컬 벡터 기준선 수치는 pgvector 의미 검색 품질이 아닙니다.
3. Ollama 계획·답변 E2E는 선행 실모델 실행에서 검증했지만 CPU 지연이 크고 7.2GB 모델은 동시 실행 프로그램으로 가용 메모리가 부족하면 로딩에 실패할 수 있습니다. 최종 강화본은 이 경우 안전 폴백을 사용하며 실시간 운영에는 GPU·소형 모델·전용 메모리가 필요합니다.
4. 웹 콘솔의 역할은 서버 환경에서 고정하지만 사용자 인증 시스템은 아닙니다. 외부 공개에는 OIDC/RBAC와 TLS 역프록시가 필요합니다.
5. 파일 원장은 HMAC 서명과 프로세스 간 잠금을 제공하지만 외부 타임스탬프나 WORM 보관은 제공하지 않습니다.
6. 그래프는 메모리 구현이라 대규모 데이터 성능을 대표하지 않습니다.
