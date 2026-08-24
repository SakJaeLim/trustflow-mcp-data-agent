# TrustFlow 발표 구성안

## 1. 한 줄 문제

“세 검색 도구를 연결하는 것보다, LLM이 만든 계획을 안전하고 검증 가능하게 실행하는 일이 더 어렵다.”

## 2. 과제 요구 완수

- Company-X 관계형 8개 테이블 → NL2SQL
- Markdown 40건 → pgvector
- 133노드·354관계 → knowledge graph
- 세 경로를 정확히 3개의 MCP 도구로 공개

## 3. 독자 기여: Typed QueryPlan

자연어와 실행 사이에 타입이 있는 중간표현을 두어 모델을 실행 권한에서 분리한다. 모든 보안·예산·근거 정책은 이 계획에 대해 결정적으로 판정한다.

## 4. PolicyGraph 실행 게이트

ALLOW, REPAIR, APPROVAL_REQUIRED, DENY의 네 결과를 제공한다. AST SQL 검사, 민감 열 역할 정책, vector topK, graph hop/node 예산을 하나의 판정 흐름에 통합한다.

## 5. 근거와 감사

표·문서·그래프 결과마다 evidenceId를 생성하고 claim 단위로 검증한다. 실행 기록은 HMAC 서명 해시 체인과 별도 서명 checkpoint로 남긴다.

## 6. 정량 검증

- 자동 테스트 37/37
- 공식 질문 라우팅·실행·근거 연결 30/30
- 정책 회귀 8/8
- pgvector Hit@1 100%, Mean Recall@5 97.14%, MRR@10 1.0
- Gemma 4 raw 도구 93.3%, 정책 정규화 후 실행·의미 정답 100%

## 7. 오픈소스·재현성

Apache-2.0, lockfile, checksum 데이터 설치, digest 고정 컨테이너, Linux CI, CycloneDX 1.5 SBOM, 라이선스·비밀·패키지 검사를 함께 제공한다. 공식 Company-X 데이터와 모델 가중치는 재배포하지 않는다.

## 8. 결론과 확장

TrustFlow는 모델을 교체해도 유지되는 데이터 실행 안전계층이다. 다음 단계는 OIDC/RBAC, 외부 WORM checkpoint, 영속 그래프 저장소와 GPU·소형 계획 모델이다.
