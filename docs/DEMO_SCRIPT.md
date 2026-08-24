# TrustFlow 3분 시연 대본

> 제출 영상과 최종 코드에는 자동 테스트 37/37을 동일하게 반영한다.

## 0:00-0:20 — 문제

화면: 첫 화면과 30개 공식 질문.

멘트: “TrustFlow는 Company-X의 SQL·문서·관계 데이터를 세 개의 MCP 도구로 연결합니다. 핵심 차별점은 언어모델의 계획을 바로 실행하지 않고 Typed QueryPlan과 내부 PolicyGraph가 먼저 검증한다는 점입니다.”

## 0:20-0:50 — NL2SQL 보정

화면: `2025년 3분기 총 매출액은 얼마야?` 실행.

멘트: “자연어가 Typed QueryPlan이 되고, LIMIT가 없으면 REPAIR한 뒤 읽기 전용 PostgreSQL에서 실행합니다. 답변은 SQL 근거 ID와 연결됩니다.”

## 0:50-1:20 — pgvector 근거

화면: `Product-C1 설치 방법이 궁금해` 실행, DOC-011 펼치기.

멘트: “40개 문서를 nomic-embed-text로 임베딩했습니다. DOC-011이 1순위이며 답변 문장과 원문 근거를 함께 확인할 수 있습니다.”

## 1:20-1:45 — 지식그래프

화면: `Client-A가 사용 중인 제품 목록은?` 실행.

멘트: “133개 노드와 354개 관계에서 Client-A, USES, 제품 경로를 탐색합니다. 방향·홉·결과 수가 계획에 명시됩니다.”

## 1:45-2:15 — 공격 차단

화면: 오른쪽 `쓰기 공격 차단` 버튼.

멘트: “DELETE 계획은 POL-SQL-001과 POL-SQL-004에 걸려 DENY됩니다. 실행은 0건이며 DB 권한도 SELECT 전용입니다.”

## 2:15-2:40 — 로컬 LLM과 감사

화면: 정책·계획·evidence ledger, 터미널의 `npm run smoke:ollama:e2e` 결과.

멘트: “처음 보는 표현은 로컬 Gemma 4가 JSON 계획을 만들지만 같은 게이트를 통과합니다. 승인된 계획은 등록된 MCP 실행기가 수행하고 급여 조회는 차단됩니다. 모든 종료 상태는 HMAC 서명 해시 체인과 별도 서명 checkpoint에 남습니다.”

## 2:40-3:00 — 검증과 결론

화면: 평가 요약.

멘트: “자동 테스트 37/37, 공식 30문항 라우팅·실행·근거 연결 30/30, 공격 8/8, pgvector Hit@1 100%를 재현했습니다. TrustFlow는 표준 MCP에 PolicyGraph의 실행 통제와 근거 감사를 결합한 온프레미스 데이터 에이전트입니다.”

화면 자막에는 “공개 공식 fixture 결과이며 비공개 테스트 정확도가 아님”을 표시합니다.

녹화용 최종 타임라인과 shot list는 `submission/DEMO_SCRIPT_3MIN.md`, `submission/VIDEO_SHOTLIST.md`를 사용합니다.
