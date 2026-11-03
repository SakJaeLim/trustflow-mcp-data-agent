# TrustFlow MCP 데이터 에이전트

자연어 질문을 SQL·벡터 검색·지식그래프 실행계획으로 바꾸고, 내부 PolicyGraph가 실행 전에 검증·보정한 뒤 근거와 감사 기록까지 반환하는 온프레미스 MCP 데이터 에이전트입니다.

현재 버전 0.3.0은 `corevalue` 팀이 리원에이스 지정과제의 공식 Company-X 데이터로 검증한 대회 제출 후보입니다. 외부 공개용 프로젝트 코드는 Apache-2.0이며, 공식 데이터셋은 대회 참가 목적으로만 사용되므로 저장소에 포함하지 않습니다.

## 공개 포트폴리오 데모

대회 데이터 없이 실행 흐름을 확인하려면 `npm ci --ignore-scripts` 후
`npm run demo:public`을 실행하세요(Node.js 24 이상). 가상 SQLite 데이터로
정상 조회와 조회 범위 보정을 실행하고, 민감정보 조회와 삭제 요청이 실행되지
않는지 검사합니다. 근거 연결 답변과 감사기록 변조 탐지도 확인합니다.
LLM이나 외부 API를 호출하지 않으며, 전체 시스템의 성능 평가를 대신하지 않습니다.
자세한 범위는 [공개 데모 안내](docs/PUBLIC_DEMO.md)를 참고하세요.

## 핵심 흐름

~~~mermaid
flowchart LR
    Q[자연어 질문] --> P[구조화 QueryPlan]
    P --> G{PolicyGraph PlanGate}
    G -->|ALLOW| X[실행]
    G -->|REPAIR| R[안전한 계획으로 보정]
    R --> X
    G -->|APPROVAL_REQUIRED| A[승인 대기]
    G -->|DENY| D[실행 차단]
    X --> S[NL2SQL]
    X --> V[Vector Search]
    X --> K[Knowledge Graph]
    S --> E[근거 연결 답변]
    V --> E
    K --> E
    E --> L[해시 체인 감사 원장]
    A --> L
    D --> L
~~~

PolicyGraph의 차별점은 “LLM이 만든 계획을 곧바로 실행하지 않는다”는 데 있습니다.

- ALLOW: 정책을 만족하는 계획을 실행합니다.
- REPAIR: SQL LIMIT, 벡터 topK, 그래프 탐색 깊이 등을 허용 범위로 보정한 뒤 실행합니다.
- APPROVAL_REQUIRED: 연봉·연락처 등 제한 필드는 승인 전까지 실행하지 않습니다.
- DENY: 쓰기 SQL, 다중 문장, 미등록 테이블·관계 등은 실행하지 않습니다.

## 현재 구현 범위

| 영역 | 구현 상태 |
|---|---|
| 공식 Company-X 데이터 | 체크섬 검증 설치 스크립트와 로컬 비공개 보관 |
| NL2SQL | 공식 10문항 계획·실행, SELECT 전용 정책, PostgreSQL 읽기 전용 계정 |
| 벡터 검색 | 재현용 로컬 768차원 기준선 + Ollama/pgvector 운영 어댑터 |
| 지식그래프 | 공식 133개 노드·354개 관계 탐색 및 관계 집계 |
| MCP | air 기반 nl2sql, vector_search, knowledge_graph 3개 도구 |
| 웹 데모 | 30개 질문, 서버 고정 역할, 정책·계획·근거 패널 |
| 로컬 LLM | Ollama 계획 fallback·근거 제한 답변 어댑터, 기본 비활성 |
| 정책 그래프 | ALLOW / REPAIR / APPROVAL_REQUIRED / DENY 판정 |
| 근거 | 표·문서·그래프 경로별 증거 ID와 답변 claim 연결 |
| 감사 | HMAC 서명 JSONL 해시 체인 + 별도 서명 체크포인트 |
| 평가 | 공식 30문항, pgvector, Gemma 4, 내부 공격 시나리오 자동 평가 |

## 1. 빠른 시작: 완전 오프라인 기준선

요구 환경은 Node.js 24 이상과 npm입니다.

### 공식 데이터 받기

잠금 파일 그대로 의존성을 설치하고 로컬 비밀값을 생성한 뒤 공식 데이터를 받습니다.

~~~powershell
npm ci
npm run setup:local
npm run fetch:data
~~~

스크립트는 리원에이스 공식 ZIP만 내려받고 SHA-256을 확인한 뒤 data/companyx에 풉니다.

~~~text
3008476738D992857D738337B4882772E88288F7B314DA235D6A5D120827D772
~~~

이미 설치된 경우에는 원본을 덮어쓰지 않고 체크섬과 필수 파일만 확인합니다.

### 설치와 검증

~~~powershell
npm run typecheck
npm test
npm run demo
npm run evaluate
npm run compliance
~~~

오프라인 모드는 공식 SQL 시드를 메모리 SQLite에 적재하고, 문서 검색은 의존성 없는 결정적 로컬 벡터 기준선을 사용합니다. 인터넷·Ollama·Docker 없이 정책, 3종 도구, 근거, 감사를 재현하기 위한 개발 모드입니다.

평가 결과는 artifacts/evaluation에 생성됩니다.

## 2. 실제 PostgreSQL 경로

Docker Desktop이 실행된 상태에서 다음을 실행합니다.

~~~powershell
npm run setup:local
docker compose up -d --wait
docker compose ps
npm run smoke:postgres
~~~

Compose는 다음을 자동 수행합니다.

- PostgreSQL 16 + pgvector 시작
- 공식 8개 관계형 테이블과 document_chunks 생성
- 공식 시드 데이터 적재
- policygraph_reader 읽기 전용 역할 생성. DB 권한은 8개 업무 테이블과 내부 `document_chunks`에 부여하지만, NL2SQL은 8개 업무 테이블만 조회하며 `document_chunks`는 벡터 검색 어댑터에서만 사용
- 문서 청크 고유 인덱스와 HNSW 벡터 인덱스 생성

Compose는 호스트의 loopback에만 바인딩되며 `.env`에 생성된 서로 다른 무작위 관리자·읽기 전용 비밀번호를 사용합니다. 스모크 테스트는 `policygraph_reader`로 접속합니다. 별도 환경의 데이터베이스를 사용할 때는 `DATABASE_URL`을 명시하십시오.

## 3. Ollama + pgvector 문서 검색과 선택형 로컬 LLM

이 단계는 임베딩 모델 다운로드와 로컬 Ollama 서버가 필요합니다.

~~~powershell
ollama pull nomic-embed-text
ollama serve
~~~

다른 PowerShell 창에서 `npm run setup:local`이 생성한 `.env`의 관리자 연결 설정을 사용해 문서를 청킹·임베딩합니다. 실제 비밀번호가 들어간 연결 문자열은 문서나 저장소에 기록하지 않습니다.

~~~powershell
npm run ingest
~~~

운영형 MCP 런타임도 같은 `.env`의 읽기 전용 연결로 시작합니다.

~~~powershell
$env:POLICYGRAPH_RUNTIME = "postgres"
$env:VECTOR_MODE = "pgvector"
npm run dev:mcp
~~~

공식 예시 밖의 표현을 로컬 LLM이 계획 초안으로 만들고, 근거 제한 답변 합성을 사용하려면 Gemma 4 E2B를 별도로 준비한 뒤 선택형 모드를 켭니다.

~~~powershell
ollama pull gemma4:e2b
$env:POLICYGRAPH_LLM_MODE = "assist"
$env:OLLAMA_CHAT_MODEL = "gemma4:e2b"
npm run dev:mcp
~~~

LLM이 만든 계획도 동일한 PlanGate를 통과해야 합니다. 각 claim은 하나의 원자적 근거 레코드만 인용할 수 있고, 해당 근거에 없는 식별자·정확한 수치·단위를 조합하거나 문서 발췌문에 없는 문장을 만들면 결정적 근거 포매터로 대체됩니다. 로컬 검증에는 `gemma4:e2b` 5.1B Q4_K_M과 `nomic-embed-text` 137M F16을 사용했습니다.

~~~powershell
npm run smoke:ollama
npm run smoke:ollama:e2e
npm run evaluate:pgvector
~~~

검증 머신(32GB RAM, Intel Core Ultra 5 225H, CPU 추론)에서 새 표현 3건의 계획 생성은 각각 약 58.8초, 45.0초, 33.6초였습니다. 이는 품질 점수가 아니라 해당 하드웨어의 단일 실행 관측치입니다. 최종 보안 강화 후 새 E2E에서는 모델의 Product-C1 답변이 DOC-011 기반의 엄격한 claim 검증을 통과했고, 모델이 만든 viewer 급여 SQL은 `POL-SQL-005/004`로 실행 전에 차단됐습니다. claim 검증에 실패하는 모델 출력은 결정적 답변으로 안전하게 대체됩니다.

실제 비밀번호는 `.env` 파일이나 비밀 저장소로 관리하고 저장소에 커밋하지 마십시오. Compose 이미지는 재현성을 위해 pgvector 버전과 이미지 digest를 함께 고정합니다.

## 4. 웹 데모

~~~powershell
npm run dev:web
~~~

브라우저에서 http://127.0.0.1:4173 을 열면 다음을 한 화면에서 확인할 수 있습니다.

- SQL·Vector·Graph 공식 질문 30개
- Typed QueryPlan
- ALLOW / REPAIR / APPROVAL_REQUIRED / DENY 판정
- 일치 정책, finding, repair
- 검증된 답변과 evidence ledger
- 쓰기 공격, 민감필드, 검색 예산 스트레스 시나리오

웹 역할은 `POLICYGRAPH_ACTOR_ROLE`로 서버에서 고정하며 요청 본문의 역할 값은 무시합니다. 웹 API는 loopback Host·same-origin·JSON·64 KiB 본문·질문 4,096바이트·요청률·동시 실행 제한을 적용합니다. MCP와 계획기에도 같은 질문 제한을 적용합니다. 외부 공개 전에는 별도의 인증·TLS 역프록시가 필요합니다.

## 5. MCP 도구

| MCP 도구 | 입력 | 실행 경로 |
|---|---|---|
| nl2sql | Company-X 자연어 분석 질문 | QueryPlan → SQL 정책 → 읽기 전용 SQL |
| vector_search | 문서 질문, 선택 topK | QueryPlan → 검색 예산 정책 → 문서 근거 |
| knowledge_graph | 관계형 자연어 질문 | QueryPlan → 관계/홉 정책 → 그래프 경로 |

MCP 호스트 설정 예시는 다음과 같습니다.

~~~json
{
  "mcpServers": {
    "trustflow-companyx": {
      "command": "node",
      "args": ["C:/absolute/path/to/trustflow-mcp-data-agent/src/mcp/server.ts"],
      "env": {
        "COMPANYX_DATA_DIR": "C:/absolute/path/to/trustflow-mcp-data-agent/data/companyx",
        "POLICYGRAPH_RUNTIME": "offline",
        "POLICYGRAPH_ACTOR_ROLE": "analyst"
      }
    }
  }
}
~~~

서버가 노출하는 역할은 호스트 환경에서 정하며 모델 입력으로 바꿀 수 없습니다. `nl2sql`의 선택형 `approvalReceipt`는 관리자만 발급할 수 있는 HMAC 서명값이며, 사용자·역할·정규화된 계획에 결합되고 5분 안에 한 번만 사용할 수 있습니다.

## 6. 평가 결과

현재 로컬 재현 실행 결과:

- 공식 예시 질문: 30개
- 자동 테스트: 49/49
- 도구 라우팅: 30/30
- 실행 성공: 30/30
- 근거 연결 답변: 30/30
- 내부 공격·경계 사례 정책 판정: 8/8
- 오프라인 P95: 84.15ms
- PostgreSQL + pgvector P95: 199.52ms(fallback 0건)
- pgvector 공식 문서 10문항: Hit@1 100%, Mean Recall@5 97.14%, MRR@10 1.0
- pgvector 준비 호출 / warm P95: 69.36ms / 132.02ms
- 2026-08-24 선행 Gemma 4 실모델 대표 의역 30건: 계획 스키마 100%, raw 도구 93.3%, 정책 정규화 후 도구·실행·의미 정답 100%
- 최종 강화본의 모델 장애 회귀: 8/8 안전 처리(현재 저메모리 실행은 모델 응답 0건, 안전 폴백 8건)

상세 결과는 [평가 요약](artifacts/evaluation/SUMMARY.md), [PostgreSQL 요약](artifacts/evaluation/SUMMARY-postgres.md), [pgvector 요약](artifacts/evaluation/PGVECTOR_SUMMARY.md)에서 확인할 수 있습니다.

민감 필드가 포함된 공식 문항은 평가용으로 이름이 기록된 승인을 제공한 뒤 실행합니다. 표의 “근거 연결 답변”은 claim이 실제 evidenceId를 참조하는지 검사한 기본 지표이고, 모델 답변 경로는 여기에 원자적 단일 근거·정확한 수치와 단위·문서 발췌 일치 검사를 추가합니다. 의미적 정답률은 별도 공개 fixture 판정 결과입니다. P95는 실행 전 `started` 기록과 종료 기록을 각각 디스크에 동기화하는 강화된 감사 경로를 포함합니다. 최종 PostgreSQL 평가는 10개 문서 질의 모두 pgvector를 사용했고 `local-vector-fallback`은 0건이었습니다. 40개 벡터의 좌표·메타데이터·원본 문서 결합 상태도 같은 실행에서 해시 검증을 통과했습니다. Gemma 품질 수치는 저장된 선행 실모델 실행이고, 최종 강화본 회귀는 모델 호출 실패 후의 안전성 결과입니다. 서로 다른 실행 결과를 합산하지 않습니다. 모든 수치는 공개 fixture 기준이며 대회 비공개 테스트 성능이나 범용 자연어 정확도를 의미하지 않습니다.

## 7. 보안 경계

PolicyGraph는 한 겹의 문자열 필터에만 의존하지 않습니다.

1. 구조화된 QueryPlan만 실행기에 전달합니다.
2. PostgreSQL AST 검사기가 단일 읽기 질의, 8개 업무 테이블·허용 열, 비재귀 CTE, 함수·잠금·whole-row projection을 검사합니다. CTE 이름으로 스키마 테이블을 가리는 우회, 중첩 wildcard, 테이블 열 별칭 목록, `JOIN ... USING`, cross join, 깊이·노드 수·관계 수 예산 초과를 차단합니다.
3. PlanGate가 질문 4,096바이트, 민감 필드·결과 예산·그래프 관계를 검사하고, SQL 결과는 외부 래퍼로 최대 100행을 강제합니다.
4. PostgreSQL 실행 계정은 로그인·연결 수 제한과 함께 상속·역할 생성·DB 생성·복제·RLS 우회 권한을 모두 제거하고, 8개 업무 테이블과 내부 `document_chunks`에만 `SELECT`를 가집니다. NL2SQL은 내부 문서 테이블에 접근할 수 없습니다. 실행에는 READ ONLY 트랜잭션과 5초 statement timeout을 함께 사용합니다.
5. 승인은 사용자·서버 역할·정확한 계획에 결합한 단기 HMAC 영수증이며 재사용할 수 없습니다.
6. 답변 claim은 원자적 근거 하나만 인용하고, 그 근거가 실제로 지지하는 식별자·정확한 수치와 단위·문서 발췌만 사용할 수 있습니다.
7. 모든 런타임은 도구 실행 전에 `started`, 종료 후 최종 상태를 HMAC 서명 해시 체인에 기록하고 별도 서명 체크포인트를 갱신합니다. 원문 질문은 저장하지 않고 도메인 분리 SHA-256 digest만 기록하며, 원장 크기·레코드 수·레코드 크기 예산과 정확한 head 일치를 강제합니다.
8. 공식 데이터는 설치 때뿐 아니라 매 런타임·평가·문서 적재 때 인증된 ZIP 스냅샷으로 고정합니다. PostgreSQL 8개 업무 테이블과 pgvector 40개 청크도 원본 내용·세대·청크 해시·768차원·읽기 역할과 대조합니다.
9. 데이터·제출 ZIP은 압축 전에 중앙/로컬 헤더, CRC, payload 범위와 중첩, Windows 호환 경로, 대소문자·Unicode 중복, 링크, 항목 수·크기·압축률을 검사합니다. 소스 스냅샷과 최종 ZIP의 실제 항목 모두를 비밀 검사합니다.
10. MCP와 웹의 실패 응답은 상관 ID만 제공하고 내부 연결정보를 노출하지 않습니다. Ollama는 자격증명 없는 loopback HTTP만 허용하고 응답 크기·시간을 제한하며, 공유 채팅·임베딩 어댑터는 두 번째 동시 모델 작업을 네트워크 호출 전에 거절합니다. 장애 시 계획과 답변은 안전한 결정론 경로로 전환됩니다.

## 8. 저장소 구조

~~~text
src/
  adapters/        PostgreSQL, pgvector, Ollama 연결
  core/            QueryPlan, 정책 판정, 근거 계약
  evidence/        답변 구성과 해시 체인 감사 원장
  mcp/             air MCP 서버와 3개 공식 도구
  planner/         공식 질문용 결정적 계획기
  policy/          PlanGate와 정책 카탈로그
  tools/           SQL·벡터·그래프 실행기
  web/             로컬 evidence console
db/init/           읽기 전용 역할과 벡터 인덱스
policy/            RDF/SHACL 형태 정책 그래프
scripts/           데이터 설치, 데모, 평가, 적재, 스모크 검사
test/              단위·통합·공식 30문항 테스트
docs/              아키텍처와 개발 명세
~~~

## 9. 알려진 제한과 다음 단계

1. 공식 30문항은 재현성을 위해 결정적 계획을 사용하며, 자유 표현의 범용 계획 품질은 Gemma 4 구조화 출력에 의존합니다. 모델 장애 시 알려진 문서 질의는 제한된 검색 계획으로 전환하고 그 밖의 미확인 계획은 실행하지 않습니다.
2. CPU 기반 Gemma 4는 수십 초가 걸리고, 다른 메모리 집약 프로그램과 동시 실행하면 7.2GB 모델 로딩이 실패할 수 있습니다. 실시간 운영에는 GPU·더 작은 모델·계획 캐시·전용 메모리 중 하나가 필요합니다.
3. 웹은 loopback 데모 경계이며 사용자 인증 시스템이 아닙니다. 외부 공개에는 OIDC/RBAC와 TLS 역프록시가 필요합니다.
4. 감사 원장과 서명 체크포인트를 함께 삭제하거나 함께 교체하면 로컬 파일만으로는 이를 탐지할 수 없습니다. 운영에서는 체크포인트를 원장과 독립된 저장소나 WORM에 보관해야 합니다.
5. 그래프는 133노드 규모의 메모리 구현입니다. 대규모 적용 시 영속 그래프 저장소와 부하 시험이 필요합니다.

## 10. 제출 자료

로컬 제출 후보 결과보고서 DOCX·PDF, 제출자 체크리스트와 무결성 목록은 `artifacts/submission/`에 있으며 개인정보·제출 작업물 혼입을 막기 위해 공개 저장소에서는 제외합니다. 공개 저장소에는 재현 가능한 소스, 평가 원자료, CycloneDX SBOM, 모델·데이터·AI 활용 고지를 포함합니다.

시연은 `docs/DEMO_SCRIPT.md`, 모델·데이터·AI 사용 범위는 `docs/MODEL_CARD.md`, `docs/DATA_LICENSE.md`, `docs/AI_USAGE.md`를 따릅니다.

## 라이선스

프로젝트 코드는 Apache License 2.0입니다. 공식 Company-X 데이터셋은 리원에이스가 명시한 대회 참가 목적 범위에서만 사용하며, 이 저장소에는 포함하지 않습니다.
