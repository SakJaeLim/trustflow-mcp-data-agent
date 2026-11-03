# 임석제 프로젝트 포트폴리오

공공기관의 정보화 전략과 데이터 활용을 다루며, AI의 실행 과정과 결과를 확인할 수 있는 도구를 만들고 있습니다. 아래 두 프로젝트는 실행 가능한 공개 데모와 검증 절차를 함께 제공합니다.

## TrustFlow

AI가 데이터 조회 계획을 만들더라도 실행 여부는 별도로 판단해야 한다는 문제에서 시작했습니다. TrustFlow는 조회 계획을 검사해 허용하거나 범위를 보정하고, 민감정보에는 승인을 요구하며, 삭제 요청은 차단합니다. 실행 결과에는 근거와 감사기록을 연결합니다.

공개 데모는 가상 SQLite 데이터로 정상 조회, 범위 보정, 승인 대기, 삭제 차단을 재현합니다. 차단된 요청이 데이터베이스에 전달되지 않는지와 감사기록 변조가 탐지되는지도 검사합니다. MCP 연결에는 공식 SDK와 수정된 검증 라이브러리를 사용합니다.

- [코드와 실행 방법](https://github.com/SakJaeLim/trustflow-mcp-data-agent)
- [공개 데모 안내](https://github.com/SakJaeLim/trustflow-mcp-data-agent/blob/main/docs/PUBLIC_DEMO.md)
- [자동 검증 결과](https://github.com/SakJaeLim/trustflow-mcp-data-agent/actions)

## PaperOps

연구자료를 모으는 것만큼 원고의 주장과 수치를 확인하는 일이 중요하다고 생각해 개발한 도구입니다. 문헌과 근거를 정리하고, 원고에서 추가 검토가 필요한 내용을 찾으며, 사람이 확인한 근거와 자동으로 추출한 후보를 구분합니다.

공개 데모는 가상 원고를 실험표와 비교해 일치하는 수치와 표에 없는 수치를 구분하고, 출처 없는 단정적인 문장을 표시합니다. 원고를 그대로 보존하는지, 사람의 확인 없이 검증 완료로 바뀌지 않는지도 확인합니다.

- [코드와 실행 방법](https://github.com/SakJaeLim/paperops)
- [공개 데모 안내](https://github.com/SakJaeLim/paperops/blob/main/docs/PUBLIC_DEMO.md)
- [자동 검증 결과](https://github.com/SakJaeLim/paperops/actions)

## 검증 범위

두 공개 데모는 API 키나 비공개 자료 없이 실행할 수 있습니다. TrustFlow의 데모는 SQL 실행 통제와 근거 기록을, PaperOps의 데모는 원고 점검과 확인 절차를 보여줍니다. 전체 제품의 운영 성능이나 LLM 정확도를 측정한 결과는 아닙니다. 수치가 원본 표와 일치하더라도 연구 결과의 진실성까지 보증하지는 않습니다.

## English

I work on public-sector information strategy and data use, and build tools that make AI actions and results easier to review.

**TrustFlow** checks proposed data queries before execution and connects results to evidence and audit records. Its offline demo uses synthetic data to demonstrate allowed queries, repaired query limits, approval requirements, blocked deletion, and audit tamper detection.

**PaperOps** organizes research evidence and flags claims that need further review. Its offline demo checks numerical claims against a synthetic experiment table, identifies an unsourced strong claim, preserves the draft, and rejects verification without human attestation.

Both projects include reproducible demonstrations and automated checks. These demonstrate specific workflows, not production certification or an LLM accuracy benchmark.
