# Third-party notices

TrustFlow MCP 데이터 에이전트 자체 코드는 Apache License 2.0으로 배포합니다. 아래는 실행·개발에 직접 사용한 핵심 제3자 구성요소입니다. 전체 npm 전이 의존성과 의존 관계는 `artifacts/submission/policygraph-sbom.cdx.json`의 CycloneDX 1.5 문서를 기준으로 합니다.

| 구성요소 | 버전 | 라이선스 | 공식 저장소 |
|---|---:|---|---|
| @airmcp-dev/core | 0.1.6 | Apache-2.0 | https://github.com/airmcp-dev/air |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| pg (node-postgres) | 8.23.0 | MIT | https://github.com/brianc/node-postgres |
| pgsql-ast-parser | 12.0.2 | MIT | https://github.com/oguimbal/pgsql-ast-parser |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| TypeScript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Node.js | 24.14.1 | MIT | https://github.com/nodejs/node |
| PostgreSQL | 16.15 | PostgreSQL License | https://www.postgresql.org/ |
| pgvector | 0.8.6 | PostgreSQL License | https://github.com/pgvector/pgvector |
| Ollama | 0.24.0 | MIT | https://github.com/ollama/ollama |
| gemma4:e2b | 7fbdbf8f5e45 | Apache-2.0 | https://ollama.com/library/gemma4:e2b |
| nomic-embed-text | 0a109f422b47 | Apache-2.0 | https://ollama.com/library/nomic-embed-text |

각 구성요소의 저작권과 라이선스는 해당 권리자에게 있습니다. 모델 가중치와 Company-X 데이터는 이 저장소에서 재배포하지 않습니다.
