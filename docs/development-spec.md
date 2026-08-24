# TrustFlow MCP 데이터 에이전트 개발 명세

## 1. 제품 정의

TrustFlow MCP 데이터 에이전트는 리원에이스 지정과제의 SQL·문서·관계 데이터를 MCP 도구로 제공하고, 내부 PolicyGraph를 통해 실행 전 정책 판정과 실행 후 근거·감사를 추가하는 로컬 우선 데이터 에이전트입니다.

## 2. 사용자와 대표 시나리오

| 사용자 | 목적 | 대표 결과 |
|---|---|---|
| 일반 분석가 | 매출·계약·프로젝트 질의 | 제한된 읽기 전용 표 |
| 기술지원 담당자 | 장애·설치·운영 문서 탐색 | 문서 ID와 발췌문 |
| 계정 담당자 | 고객·제품·직원 관계 확인 | 관계 경로와 결과 노드 |
| HR 분석가 | 승인된 인사 지표 확인 | 역할 정책을 통과한 제한 필드 |
| 감사자 | 누가 무엇을 왜 실행했는지 확인 | 계획·판정·근거 해시 원장 |

## 3. 기능 요구사항

### FR-01 자연어 도구 선택

- 공식 questions.json의 30문항을 기대 도구로 분류해야 합니다.
- 결과 도구는 sql.query, vector.search, graph.traverse 중 하나여야 합니다.

수용 기준: 공식 30문항 라우팅 30/30.

### FR-02 NL2SQL

- 공식 SQL 10문항의 실행 가능한 SELECT 계획을 생성해야 합니다.
- 쓰기·DDL·관리 명령은 실행할 수 없어야 합니다.
- 결과 상한이 없으면 LIMIT 100을 추가해야 합니다.

수용 기준: 10문항 실행 성공, DELETE 공격 DENY, 미등록 테이블 DENY.

### FR-03 문서 검색

- 40개 Markdown 문서를 청크와 768차원 임베딩으로 적재할 수 있어야 합니다.
- 문서 유형 필터와 topK를 지원해야 합니다.
- topK는 1~10으로 보정해야 합니다.

수용 기준: 공식 문서 질문 10개 모두 하나 이상의 근거 반환. Product-C1 설치 질문의 상위 결과에 DOC-011 포함.

### FR-04 지식그래프

- 133개 노드와 354개 관계를 로드해야 합니다.
- 정방향·역방향 관계와 최대 2홉 탐색을 지원해야 합니다.
- 관계 수 기반 순위를 지원해야 합니다.

수용 기준: 공식 그래프 질문 10개 모두 실행 성공.

### FR-05 MCP

- air 기반 stdio 서버로 nl2sql, vector_search, knowledge_graph만 노출해야 합니다.
- 모든 도구는 PlanGate를 우회하지 않아야 합니다.
- 역할과 승인자는 모델이 임의 설정할 수 없어야 합니다.

수용 기준: MCP 도구 목록 정확히 3개, 각 경로 호출 테스트 통과.

### FR-06 정책 판정

- ALLOW, REPAIR, APPROVAL_REQUIRED, DENY를 구분해야 합니다.
- 원본 계획을 변경하지 않고 별도 executablePlan을 만들어야 합니다.
- 모든 finding과 repair는 정책 ID로 역추적 가능해야 합니다.

수용 기준: 내부 공격·경계 사례 8/8 기대 판정.

### FR-07 근거 연결 답변

- 표, 문서, 그래프 실행 결과에 안정적 evidenceId를 생성해야 합니다.
- 답변 claim은 정확히 하나의 알려진 evidenceId를 가져야 하며, 서로 다른 행·문서·그래프 근거의 사실을 조합하면 안 됩니다.
- 식별자·정확한 수치와 단위·문서 발췌는 해당 claim이 인용한 원자적 근거가 직접 지지해야 합니다.
- 근거가 없으면 verified=false여야 합니다.

수용 기준: 공식 30문항 answer.verified=true.

### FR-08 감사

- executed, denied, approval_required, failed를 모두 기록해야 합니다.
- 원본·실행 계획 해시, 원문 질문 대신 도메인 분리 query digest, 근거 ID, 도구 호출, 승인을 기록해야 합니다.
- 레코드 변경·삭제·재정렬과 원장 truncate를 탐지해야 합니다.
- 레코드와 head checkpoint를 HMAC 서명하고 프로세스 간 append를 직렬화하며, checkpoint는 현재 원장 head와 정확히 일치해야 합니다.

수용 기준: 정상 체인 검증 통과, 임의 필드 변경·혼합 서명·원장 삭제 및 truncate 검증 실패.

## 4. 비기능 요구사항

| ID | 요구사항 | P0 기준 |
|---|---|---|
| NFR-01 | 재현성 | Node 24에서 한 명령으로 테스트 |
| NFR-02 | 로컬 우선 | 오프라인 기준선은 외부 API 호출 없음 |
| NFR-03 | 최소 권한 | PostgreSQL 런타임 계정 SELECT 전용 |
| NFR-04 | 제한 실행 | SQL 5초, 100행, Vector 10건, Graph 2홉·50노드 |
| NFR-05 | 설명 가능성 | 결정·finding·repair·정책 ID 반환 |
| NFR-06 | 데이터 보호 | 공식 데이터와 환경 비밀은 Git 제외 |
| NFR-07 | 라이선스 | 자체 코드 Apache-2.0, 데이터 라이선스 분리 |
| NFR-08 | 공급망 | 잠금 설치, 이미지 digest, SBOM, 라이선스·비밀 검사 |
| NFR-09 | 입력·압축 예산 | 질문 4,096바이트, 문서 corpus·chunk·batch 및 ZIP 항목·크기·압축률 제한 |

## 5. 개발 단계

### P0 — 완료된 수직 슬라이스

- 공식 데이터 설치·무결성 확인
- QueryPlan과 PlanGate
- SQL·Vector·Graph 실행기
- air MCP 3종 도구
- 근거 답변과 해시 체인 감사
- 공식 30문항·공격 8건 평가
- PostgreSQL 읽기 전용 실연결
- 계획·정책·근거를 보여주는 로컬 웹 evidence console
- PostgreSQL AST SQL 검사와 외부 결과 행 제한
- SQL 별칭 목록·JOIN USING·cross join·관계 수 우회와 NL2SQL 내부 문서 테이블 접근 차단
- 계획 결합 단기 승인과 재시작 간 replay 방지
- query digest 기반 HMAC 서명 감사 원장·정확한 head checkpoint·프로세스 간 잠금
- bounded 문서 ingestion·공식 데이터 다운로드와 사전 ZIP 구조 검증
- Linux CI, CycloneDX SBOM, 라이선스·비밀·패키지 검사

### P1 — 완료된 대회 데모

1. Ollama nomic-embed-text 설치 및 40개 문서/40개 청크 임베딩
2. pgvector 검색의 공식 문서 10문항 정답 라벨 작성
3. Hit@k, Recall@k, MRR, warm latency 측정
4. Gemma 4 계획·근거 답변 및 민감 SQL 차단 E2E 검증
5. 데스크톱·모바일 evidence console과 공격 시나리오 검증

### P2 — 운영 확장 후보

1. OIDC/RBAC 기반 승인 워크플로
2. TLS 역프록시와 중앙 비밀 관리
3. 장애 주입·복구·부하 테스트
4. 외부 타임스탬프 또는 WORM 감사 체크포인트
5. 대규모 영속 그래프 저장소

## 6. 3분 데모 시나리오

| 시간 | 장면 | 입증할 내용 |
|---:|---|---|
| 0:00–0:25 | 문제 정의 | 세 데이터 검색보다 실행 신뢰성이 핵심 |
| 0:25–0:55 | NL2SQL | LIMIT 자동 보정과 실제 PostgreSQL 결과 |
| 0:55–1:20 | 벡터 검색 | 문서 ID·점수·발췌 근거 |
| 1:20–1:45 | 그래프 | Client-A → USES → 제품 경로 |
| 1:45–2:10 | 승인 대기 | analyst 연봉 질의가 실행 전 중지 |
| 2:10–2:30 | 공격 차단 | DELETE가 DB에 도달하지 않고 DENY |
| 2:30–2:50 | 감사 | 원본 계획·보정·근거·이전 해시 확인 |
| 2:50–3:00 | 결론 | 안전하고 설명 가능한 온프레미스 MCP |

## 7. 검증 명령

~~~powershell
npm run typecheck
npm test
npm run evaluate
npm run demo
docker compose up -d --wait
npm run smoke:postgres
npm run evaluate:pgvector
npm run smoke:ollama:e2e
~~~

오프라인 평가와 pgvector 평가는 별도 파일로 기록하며, 공개 공식 문항 결과를 비공개 테스트나 범용 자연어 정확도로 표현하지 않습니다.

## 8. 완료 정의

다음이 모두 충족되어야 한 단계가 완료됩니다.

- 구현 코드와 실패 재현 테스트가 함께 존재
- 타입 검사와 전체 테스트 통과
- 공식 데이터 원본은 저장소에 포함되지 않음
- 평가 수치의 데이터셋·런타임·제약을 함께 명시
- 설치부터 데모까지 새 환경에서 재현
- 미완료 기능을 완료된 것처럼 README나 발표자료에 기재하지 않음
