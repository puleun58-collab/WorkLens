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

### 2.2 완료 기준
**위치**: 계획의 `acceptance` + `tests` 섹션

**통합 방안**:
- 2.1과 동일한 패턴으로 criterion 타입 검토

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
