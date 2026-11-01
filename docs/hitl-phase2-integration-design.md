# HITL 2차 UI 통합 설계

## 개요
HITL 1차에서 구현한 데이터 모델(v2 스키마, reviews 배열)과
2차 기반(검토 로직 `hitl.ts`, UI 컴포넌트 `HitlReview.tsx`)을
실제 화면에 통합하는 설계.

## 1. 업무 진단 화면 (Step 2)

### 1.1 단계별 자동화 판단 테이블
**위치**: `AxProcess` > "단계별 자동화 판단" 섹션 (`AxStepTable`)

**현재 구조**:
```
<section>
  <h3>단계별 자동화 판단</h3>
  <table> <!-- 각 행: 업무 단계 | 판정 | 담당 | 판단 근거 -->
</section>
```

**통합 방안**:
- 테이블에 "검토" 열 추가 (5번째 열)
- 각 행에 `HitlStatusBadge` 표시 (review가 있으면 상태, 없으면 "검토 전")
- "검토" 버튼 클릭 시 해당 행 아래에 `HitlReviewPanel` 펼침 (아코디언)
- `onSave` 시 `updateTaskReviews(taskId, newReview)` 호출

**Props 전달**:
```tsx
<AxStepTable
  diagnosis={d}
  taskId={task.id}
  reviews={task.reviews}
  onSaveReview={(review) => saveReview(task.id, review)}
/>
```

### 1.2 위험 사항
**위치**: 진단 화면의 위험 섹션 (현재 `risks` 표시 위치 확인 필요)

**통합 방안**:
- 각 위험 항목 옆에 상태 배지 + 검토 버튼
- Step 1.1과 동일한 패턴

## 2. 결과·로드맵 화면 (Step 3)

### 2.1 구현 계획 항목
**위치**: `AxPlanSection` > 계획 항목 목록

**현재 구조**: Codex/Claude Code 탭별 계획 표시

**통합 방안**:
- 각 계획 항목(`implementation` 배열)에 검토 UI 추가
- `extractPlanReviewableItems(plan, tool)`로 항목 추출
- 도구별(source) 구분 유지
- 구현 계획은 `implementation` 원본 배열 순서로 기본 펼침 표시하며, 번호는 원본 index+1을 `01` 형식으로 표시한다. 업무 분류는 단계별 보조 라벨일 뿐 정렬·검토 키에 영향을 주지 않는다.
- 전체 목록은 접을 수 있지만 검토 패널이 열린 동안은 입력 보호를 위해 펼침을 유지한다.

### 2.2 완료 기준
**위치**: 계획의 `acceptance` + `tests` 섹션

**통합 방안**:
- 2.1과 동일한 패턴으로 criterion 타입 검토
- 구현 범위와 완료 기준은 데스크톱 2열·모바일 1열이며 카드 높이는 콘텐츠에 따라 독립적이다.
- 구현 범위 5개 그룹은 실제 항목 수·원본 기반 요약을 표시하고 기본 접힘이다. 개별 펼침 또는 하단 `전체 보기`에서 보류 사유·재개 조건을 포함한 전체 항목을 확인한다.
- 완료 기준의 원형 아이콘은 모든 항목에 동일한 하늘색(`#BFDBFE`)을 사용한다. 검토 상태는 별도의 기존 상태 표시로 구분하고 `HitlReviewPanel` 기본 디자인·저장 연결은 유지한다.

## 3. 저장 핸들러

### 3.1 saveReview(taskId, review)
```typescript
function saveReview(taskId: string, review: HitlReview) {
  update(current => ({
    ...current,
    tasks: current.tasks.map(t =>
      t.id === taskId
        ? {
            ...t,
            reviews: [
              ...(t.reviews ?? []).filter(r => r.target.key !== review.target.key),
              review,
            ],
          }
        : t
    ),
  }));
}
```

### 3.2 stale 자동 판정
**트리거**: 재진단 완료 후, Factor 보정 후, 계획 재생성 후

```typescript
function markStaleReviews(taskId: string, newDiagnosis: AxDiagnosis) {
  const items = extractReviewableItems(newDiagnosis);
  const itemMap = new Map(items.map(i => [i.key, i.sourceHash]));

  update(current => ({
    ...current,
    tasks: current.tasks.map(t => {
      if (t.id !== taskId || !t.reviews) return t;
      return {
        ...t,
        reviews: t.reviews.map(r => {
          const currentHash = itemMap.get(r.target.key);
          if (!currentHash) return r; // 대상 소멸 → 유지 (수동 확인)
          if (r.status === "confirmed" && r.target.sourceHash !== currentHash) {
            return { ...r, status: "stale", updatedAt: new Date().toISOString() };
          }
          return r;
        }),
      };
    }),
  }));
}
```

## 4. 컴포넌트 수정 목록

| 파일 | 수정 내용 |
|------|-----------|
| `AxDiagnosisView.tsx` | `saveReview`, `markStaleReviews` 핸들러 추가; Step 2에 검토 UI 전달 |
| `AxReport.tsx` | `AxStepTable`에 검토 열 추가; `AxPlanSection`에 계획 검토 UI 추가 |
| `HitlReview.tsx` | (기존) 변경 없음 |

## 5. 테스트 계획

- `tests/hitl-integration.test.ts` (신규):
  - 검토 저장 후 새로고침 시 복원
  - 재진단 후 변경된 항목만 stale
  - 무관한 항목은 confirmed 유지
  - 업무 수정 시 reviews 보존

## 6. 주의사항

- PR #163 머지 후 시작 (AxDiagnosisView.tsx 충돌 방지)
- PR #164 머지 후 시작 (기반 코드 안정화)
- 기존 E2E 테스트 회귀 확인 필수

## 업무 규칙 도출·재진단 보존 계약

- `rule-questions.ts`는 업무명·확장자·입력 개수 대신 목적, 실제 단계, 단계별 판단, TO-BE, 처리 예외, 사람 개입 및 구현 범위의 근거를 조합한다. D1은 대조 동작과 대상, D2는 중복 처리 위험, D3은 비수치 예외도 포함한 실제 예외, D4는 결과 상태, D5는 실행 중 정보 부족·판단 불가, D6은 실제 파일·데이터 수신, D7은 계산·집계 조건이 필요하다.
- 기술 제공·권한 확인은 구현 전 확인 사항으로 유지한다. 기술 확인 항목에 실행 실패 처리 조건도 있으면 그 처리 절만 미확정 규칙 후보로 분리하며 원문은 이동·삭제하지 않는다.
- 자동 후보는 **제안**, 직접 추가 항목은 **신규**로 표시한다. 자동 후보는 사용자 수정 전에는 저장하지 않는다. 동일한 전체 처리 조건만 중복 후보를 줄이며 이름이 같아도 조건·단계가 다르면 독립 검토한다.
- `diagnosis-preservation.ts`의 `applyRediagnosis`는 최신 사용자 상태에서 D1~D7, 범용 규칙의 ID·상태·기준·분류·적용 여부·근거·단계 연결, 기술 확인 기록과 HITL 이력을 보존한다. 새 진단에서 항목이 사라지거나 충돌해도 저장 규칙을 초기화하지 않는다. 변경된 HITL 대상만 기존 기준에 따라 재확인 상태로 남긴다.
- 완료율은 표시된 모든 검토 카드가 분모다. 미확정 저장 규칙과 미터치 제안을 숨기거나 제외하지 않는다. 후보 0개는 충분한 단순 업무와 진단 정보 부족을 구분하며 검토 완료를 구현 가능으로 해석하지 않는다.
- 지시문에는 적용·확정된 처리 기준과 근거·단계 연결을 전달한다. 미확정은 확인 대상으로만 표시하고 미적용 기준 상세와 업무에 무관한 미저장 D 항목은 구현 대상으로 전달하지 않는다.
- 결정론적 검증 자료: `tests/fixtures/ax-rule-derivation.ts`의 업무 유형 9개 및 경계 A–J, `ax-rule-derivation.test.ts`, `ax-rule-preservation.test.ts`, `tests/e2e/ax-rule-derivation.spec.ts`. 반응형 화면 증거는 `artifacts/rules/`에 저장한다.
