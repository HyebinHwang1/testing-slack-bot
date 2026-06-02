# 배송정보 CSV 자동 진단 — 설계 문서

> 작성일: 2026-06-02
> 대상: 슬랙봇 "철수" (`api/slack/events.ts`)
> 관련: Part 2 셀프-그로잉 / KB `배송` 섹션의 "Partner Office 배송정보 CSV 업로드 실패 조건" 글

## 1. 목적

파트너/사업부가 배송정보 CSV 업로드 실패를 문의할 때, 봇이 첨부된 CSV를 **우리 정책(KB 글)에 비춰 형식·패턴 위반을 진단**해 답한다. 일반론 답변을 넘어 "이 파일의 무엇이 형식상 문제인지"를 짚는 것이 목표다.

## 2. 범위

### 한다
- 멘션(`@철수`) + CSV 첨부 시 진단
- 파일 다운로드·디코딩 (인코딩 판정 포함)
- KB 정책 글 + CSV를 LLM에 주입해 **형식·패턴 위반** 진단
- 진단 결과를 스레드 답글로 회신

### 안 한다 (의도적 제외)
- **주문 상태 기반 진단** (입금전취소·배송완료·결제전 등) — CSV에 상태 정보가 없고, 봇은 실제 주문 DB에 접근하지 못한다. 이 한계는 답글에 명시한다.
- 실제 주문번호 존재 여부 / 배송사 DB 등록 여부 검증 (동일 이유)
- 자동 감지(`message.channels`) 트리거 — 멘션 기반으로 한정

## 3. 유저 플로우

```
파트너/사업부                     철수 봇
     |                              |
     | @철수 + CSV 첨부 (+질문)      |
     |----------------------------->|
     |                              | app_mention 이벤트 수신
     |                              | files에 .csv 있음 → handleCsvDiagnosis
     |                              |
     |                              | 1) CSV 다운로드 (url_private_download)
     |                              | 2) 디코딩 시도
     |                              |    └ 전부 실패 → "인코딩 문제" 답글 (종료)
     |                              | 3) KB 배송 정책 글 fetch
     |                              | 4) Claude에 [정책 + CSV] 주입
     |                              |    → 형식·패턴 위반 진단 (JSON)
     |                              |
     |   스레드 답글: 진단 결과       |
     |<-----------------------------|
     |   - 위반 있음 → 항목 목록      |
     |   - 위반 없음 → "형식 문제 없음"|
     |   - 배송 CSV 아님 → 안내       |
     |   + 상태 기반 한계 고지        |
```

핵심 사용자 시나리오:
1. 파트너가 "CSV 업로드 실패해요" + `upload_ship_sample.csv` 첨부 + `@철수` 멘션
2. 봇이 즉시 진단해 "헤더 표기 불일치 / 빈 행 / 컬럼 수 불일치" 등 형식 문제를 답글로 회신
3. 형식이 멀쩡하면 "형식상 문제 없음 — 입금전취소 등 상태 문제는 담당자 확인 필요"로 안내해, 다음 확인 지점을 좁혀 줌

## 4. 아키텍처

기존 `app_mention` 라우팅에 진단 분기를 **최우선**으로 추가한다.

```
handleEvent (event.type === 'app_mention')
  ├─ csvFiles = event.files?.filter(.csv)   // 첫 .csv 대상
  ├─ csvFiles 있음 → handleCsvDiagnosis(event, slack)   ← 신규, 최우선
  ├─ event.thread_ts → handleSave   (기존)
  └─ else            → handleQuestion (기존)
```

### 컴포넌트

| 컴포넌트 | 책임 | 입력 → 출력 |
|---|---|---|
| 라우팅 (`handleEvent`) | CSV 첨부 감지 → 진단 분기 | event → 분기 |
| `downloadAndDecodeCsv()` | 파일 다운로드 + 인코딩 디코딩 | file 메타 → `{text}` 또는 인코딩 실패 |
| `fetchDeliveryPolicy()` | KB `배송` 섹션 정책 글 조회 | (없음) → 정책 텍스트 |
| `diagnoseCsvWithLlm()` | 정책+CSV로 형식·패턴 위반 추론 | 정책, csvText → 위반 목록 JSON |
| `formatDiagnosisReply()` | 진단 결과를 답글 텍스트로 | 위반 목록 → 답글 문자열 |
| `handleCsvDiagnosis()` | 위 흐름 오케스트레이션 + 답글 | event → 슬랙 답글 |

## 5. 컴포넌트 상세

### 5.1 트리거 & 라우팅
- `SlackEvent` 인터페이스에 `files?: SlackFile[]` 추가
  - `SlackFile = { id, name, filetype, url_private_download, url_private, size }`
- `app_mention` 이벤트에서 `files` 중 `filetype === 'csv'` 또는 `name.endsWith('.csv')` 인 **첫 항목**을 진단 대상으로
- 여러 CSV 첨부 시 첫 번째만 (YAGNI — 다중 파일은 추후)

### 5.2 다운로드 & 디코딩 *(코드)*
- `fetch(file.url_private_download, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } })` → `ArrayBuffer`
- 디코딩 순서: `shift_jis → utf-8-sig(BOM) → utf-8 → euc-jp` (정책 글의 인코딩 정책과 동일). Node `TextDecoder`로 시도, 깨진 문자(replacement char) 포함 여부로 성공 판정
- **전부 실패 → 인코딩 에러(①)로 즉시 답글, LLM 호출 없이 종료**
- 다운로드 실패(HTTP 비정상) → 안내 답글

### 5.3 LLM 진단 *(접근 B)*
- 정책 컨텍스트: KB `배송` 섹션 글을 `fetchKnowledge`(또는 동등 쿼리)로 가져와 프롬프트에 주입
- 입력: 정책 + CSV 텍스트(헤더 + 행). **행 수 상한 200행**, 초과 시 앞 200행만 + "이하 생략" 안내
- 시스템/지시 프롬프트 요지:
  - "아래 정책에 비춰 CSV의 **형식·패턴 위반만** 찾아라."
  - "주문 상태(입금전취소 등)·실제 주문 존재·배송사 DB 등록 여부는 CSV로 알 수 없으니 **판단하지 말 것**."
  - "배송정보 CSV 형식 자체가 아니면 그렇게 답하라."
  - 출력: JSON `{ "is_delivery_csv": bool, "violations": [{ "where": "헤더|행 N|파일", "issue": "...", "detail": "..." }] }`
- 모델: 기존 `CLAUDE_MODEL`(Haiku) 재사용

### 5.4 출력
```
📋 배송정보 CSV 진단 — {파일명} ({N}행)

⚠️ 형식·패턴 점검 결과
- [행 5] 컬럼 수 불일치 — 3열이어야 하는데 2열
- [헤더] 컬럼명 표기 불일치

ℹ️ 입금전취소·배송완료 등 주문 "상태" 기반 실패는 이 진단으로 확인 불가합니다.
   실제 상태는 담당자 확인이 필요해요.
```
- 위반 없음: "✅ 형식상 문제는 발견되지 않았어요." + ℹ️ 동일 안내
- `is_delivery_csv === false`: "첨부 파일이 배송정보 CSV 형식이 아닌 것 같아요." + 기대 헤더 안내

## 6. 에러 처리 & 한계

| 상황 | 처리 |
|---|---|
| 다운로드 실패 | "파일을 가져오지 못했어요" 안내 |
| 디코딩 전부 실패 | 인코딩 문제(①)로 진단 결과 답글 |
| LLM 호출 에러 (429/5xx) | 기존 패턴대로 "잠시 후 다시" 안내 |
| 행 200 초과 | 앞 200행만 진단 + 잘림 고지 |
| 비-CSV 첨부 | 진단 분기 안 탐 (기존 저장/질문 흐름) |

**접근 B의 본질적 한계 (문서로 고지)**: LLM은 큰 파일에서 행별 형식(컬럼 수·중복)을 결정적으로 세지 못할 수 있다. 따라서 진단은 "참고용"이며, 행 수 상한과 톤으로 완화한다. 정확도가 부족하면 추후 하이브리드(코드 검증 + LLM 안내)로 보강한다.

## 7. 변경 파일

- `api/slack/events.ts`
  - `SlackEvent`에 `files` 추가, `SlackFile` 타입 신설
  - `handleEvent`의 `app_mention` 분기에 CSV 진단 우선 라우팅
  - `handleCsvDiagnosis` / `downloadAndDecodeCsv` / `fetchDeliveryPolicy` / `diagnoseCsvWithLlm` / `formatDiagnosisReply` 추가
- Slack 앱 콘솔: **`files:read` 스코프 추가** (재설치 필요)

## 8. 테스트 전략

- **단위 테스트** (결정적 로직):
  - 디코딩: 정상 UTF-8 / shift_jis / 깨진 바이트 → 성공·실패 판정
  - 헤더·행 파싱, 행 수 상한 처리
  - `formatDiagnosisReply`: 위반 0건/N건/비-배송 CSV 분기
- **통합 확인** (LLM 부분, 비결정적): 보유 샘플 `upload_ship_sample (3).csv`로 진단 실행 → "위반 0/N건" 수준 확인 (정확한 행 단언은 하지 않음)

## 9. 미해결/추후

- 다중 CSV 첨부 시 전체 진단 (현재 첫 1개)
- 정확도가 낮으면 접근 C(하이브리드)로 전환
- 다른 업로드 양식(상품 엑셀 등)으로 진단 확장 시, 정책 글·헤더 스펙을 어떻게 다형화할지
