# Company-X data use

- 배포처: LIWONACE 지정과제 안내
- 공식 URL: https://liwonace.co.kr/notice/2
- 로컬 원본 SHA-256: `3008476738D992857D738337B4882772E88288F7B314DA235D6A5D120827D772`
- 범위: 관계형 8개 테이블 약 800행, Markdown 40건, 그래프 133노드·354관계, 공식 질문 30개

이 데이터는 대회 참가 목적의 별도 자료이며 TrustFlow의 Apache-2.0 코드 라이선스에 포함되지 않습니다. `data/raw/`와 `data/companyx/`는 Git에서 제외하며, 공개 저장소·모델 가중치·테스트 fixture로 재배포하지 않습니다.

Markdown 40건은 `document_chunks`에 40개 청크로 변환해 로컬 임베딩 검색에만 사용했습니다. 추가 학습·파인튜닝·모델 가중치 생성에는 사용하지 않았습니다. 평가 수치는 공개된 공식 질문과 수작업 라벨에 대한 개발 결과이며 비공개 테스트 성능이 아닙니다.
