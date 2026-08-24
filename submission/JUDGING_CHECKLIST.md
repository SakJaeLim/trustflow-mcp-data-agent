# 심사 대응 체크리스트

## 공식 기능·라이선스 검증 대비

- [x] MCP 서버가 `nl2sql`, `vector_search`, `knowledge_graph` 세 도구만 노출
- [x] 공식 Company-X 데이터 설치 SHA-256 검증
- [x] PostgreSQL·pgvector 실연결 평가 원자료 보존
- [x] Ollama 모델 식별자·버전·적용 방식 문서화
- [x] 자체 코드 Apache-2.0, 데이터·모델 라이선스 분리
- [x] CycloneDX 1.5 SBOM과 122개 npm 라이선스 검사
- [x] 공개 소스 ZIP에 lockfile·CI·테스트 포함, 데이터·비밀 제외

## 차별성 입증

- [x] 단순 MCP/RAG 조합과 다른 Typed QueryPlan 알고리즘 명시
- [x] AST 우회·role escalation·approval replay·audit truncation 재현 테스트 포함
- [x] raw LLM 결과와 정책 정규화 후 결과를 분리 보고
- [x] 답변 claim별 인용 evidence 검증과 안전 fallback 시연
- [x] ALLOW·REPAIR·APPROVAL_REQUIRED·DENY 네 경로를 UI에서 확인

## 정량성·정직성

- [x] 공개 fixture, 내부 회귀, 실제 PostgreSQL, 실제 Ollama 결과를 구분
- [x] 근거 연결률을 의미 정답률로 표현하지 않음
- [x] raw 도구 정확도 93.3%를 숨기지 않고 개선 후 100%와 함께 제시
- [x] CPU 지연과 로컬 웹 인증 한계를 명시
- [x] 비공개 테스트나 운영 안전성을 과장하지 않음

## 제출자 확인 필요

- [x] 접수번호 `555`
- [ ] 공개 GitHub URL과 실제 clone 설치 확인
- [ ] 3분 이내 YouTube URL과 비로그인 재생 확인
- [x] 개발 보조 AI 실제 적용 범위/비율: 개발 공정 기준 자체 산정 `약 80%`
- [x] 중복수혜 여부: `해당 없음`
- [x] 최종 DOCX·PDF 파일명: `2026 오픈소스 개발자대회 결과보고서_555(corevalue)`
