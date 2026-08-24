# Contributing to PolicyGraph

PolicyGraph는 작은 변경, 재현 가능한 검증, 명확한 라이선스 출처를 우선합니다.

## 개발 절차

1. Node.js 24 이상에서 `npm ci`를 실행합니다.
2. `npm run fetch:data`로 체크섬이 고정된 Company-X 로컬 fixture를 설치합니다.
3. 변경 전 실패 사례를 테스트로 추가합니다.
4. 최소 범위로 수정한 뒤 `npm run typecheck`, `npm test`, `npm run compliance`를 실행합니다.
5. SQL·승인·감사·MCP 경계를 바꾸면 해당 공격 회귀 테스트와 `SECURITY.md`를 함께 갱신합니다.

## 제출 규칙

- Company-X 원본 데이터, `.env`, 감사 원장, 모델 가중치를 커밋하지 않습니다.
- 새 의존성은 필요성, 대안, 라이선스, 보안 상태를 PR에 적습니다.
- 생성형 AI를 사용한 변경은 사람이 검토하고 테스트한 범위를 `docs/AI_USAGE.md`에 반영합니다.
- 프로젝트 코드는 Apache-2.0으로 기여하는 데 동의해야 합니다.

보안 취약점은 공개 이슈 대신 `SECURITY.md`의 비공개 신고 절차를 이용하십시오.
