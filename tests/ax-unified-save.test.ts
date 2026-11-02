import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import type { ReactNode } from "react";
import type * as ReactModule from "react";
import type * as RuleQuestionsModule from "@/lib/ax/rule-questions";
import { UnifiedRulesSection } from "@/components/ax/AxUnifiedRules";
import { diagnosisFixture } from "./fixtures/ax";
import type { AxDiagnosis, DecisionPoint, GenericRule } from "@/lib/ax/types";
import type { UnifiedDecisionDraft, UnifiedGenericDraft, UnifiedRuleDraft } from "@/lib/ax/rule-questions";

// Drive the section's save handler and rendered feedback with controlled persistence.
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, updated: false,
  derive: null as ((diagnosis: AxDiagnosis, genericRules?: readonly GenericRule[] | null) => UnifiedRuleDraft[]) | null,
  derivationReady: null as boolean | null,
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof ReactModule>(),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (value: unknown) => {
      harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value;
      harness.updated = true;
    }];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
}));
vi.mock("@/lib/ax/rule-questions", async importOriginal => {
  const original = await importOriginal<typeof RuleQuestionsModule>();
  return {
    ...original,
    deriveUnifiedRules: (...args: Parameters<typeof original.deriveUnifiedRules>) =>
      harness.derive ? harness.derive(...args) : original.deriveUnifiedRules(...args),
    hasDerivationSignals: (diagnosis: AxDiagnosis) =>
      harness.derivationReady ?? original.hasDerivationSignals(diagnosis),
  };
});
type NodeProps = {
  children?: ReactNode; onClick?: () => Promise<void>; disabled?: boolean; role?: string; className?: string;
  "aria-expanded"?: boolean; value?: unknown; onChange?: (value: { target: { value: string } } | Partial<UnifiedGenericDraft>) => void;
};
function nodes(node: ReactNode): NodeProps[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<NodeProps>(node)) return [];
  return [node.props, ...nodes(node.props.children)];
}
const diagnosis = { ...structuredClone(diagnosisFixture), decisionPoints: [
  { id: "D3" as const, status: "미확정" as const, detail: "작성 중 메모" },
] };
type Save = (points: DecisionPoint[], rules: GenericRule[]) => Promise<boolean>;
function render(onSave: Save, saveStatus = "이 브라우저에 저장됨", currentDiagnosis: AxDiagnosis = diagnosis, genericRules?: GenericRule[]) {
  let tree: NodeProps[];
  do {
    harness.cursor = 0;
    harness.updated = false;
    tree = nodes(UnifiedRulesSection({ diagnosis: currentDiagnosis, genericRules, onSave, saveStatus }));
  } while (harness.updated);
  return tree;
}
const saveButton = (tree: NodeProps[]) => tree.find(props => props.children === "저장")!;
const hasSuccess = (tree: NodeProps[]) => tree.some(props => props.children === "업무 규칙을 저장했습니다");
beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.updated = false;
  harness.derive = null; harness.derivationReady = null;
});

describe("AX unified rules persistence feedback", () => {
  it("keeps the edited draft when the parent updates before a failed persistence result", async () => {
    const gate = Promise.withResolvers<boolean>();
    const onSave = vi.fn(() => gate.promise);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    render(onSave).find(props => props.value === "작성 중 메모")!.onChange!({ target: { value: "  새 초안 메모  " } });
    const saving = saveButton(render(onSave)).onClick!();
    const parentDiagnosis = { ...diagnosis, decisionPoints: [
      { id: "D3" as const, status: "미확정" as const, detail: "새 초안 메모" },
    ] };
    render(onSave, "저장 중", parentDiagnosis);
    expect(render(onSave, "저장 중", parentDiagnosis).some(props => props.value === "  새 초안 메모  ")).toBe(true);
    gate.resolve(false); await saving;
    render(onSave, "저장 실패", parentDiagnosis);
    expect(render(onSave, "저장 실패", parentDiagnosis).some(props => props.value === "  새 초안 메모  ")).toBe(true);
    render(onSave, "저장 실패", parentDiagnosis).find(props => props.value === "  새 초안 메모  ")!
      .onChange!({ target: { value: "실패 후 수정한 메모" } });
    render(onSave, "저장 실패", parentDiagnosis);
    expect(render(onSave, "저장 실패", parentDiagnosis).some(props => props.value === "실패 후 수정한 메모")).toBe(true);
  });

  it("still accepts a separately restored parent value after a failed save", async () => {
    const onSave = vi.fn<Save>().mockResolvedValue(false);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    await saveButton(render(onSave)).onClick!();
    const restoredDiagnosis = { ...diagnosis, decisionPoints: [
      { id: "D3" as const, status: "미확정" as const, detail: "가져오기로 복원한 값" },
    ] };
    render(onSave, "저장 실패", restoredDiagnosis);
    expect(render(onSave, "저장 실패", restoredDiagnosis).some(props => props.value === "가져오기로 복원한 값")).toBe(true);
  });

  it("waits for persistence, blocks duplicate clicks, and reports success only with global saved status", async () => {
    const gate = Promise.withResolvers<boolean>();
    const onSave = vi.fn(() => gate.promise);
    const saving = saveButton(render(onSave)).onClick!();
    const pending = render(onSave, "저장 중");
    expect(hasSuccess(pending)).toBe(false);
    expect(saveButton(pending).disabled).toBe(true);
    await saveButton(pending).onClick!();
    expect(onSave).toHaveBeenCalledTimes(1);
    gate.resolve(true); await saving;
    expect(hasSuccess(render(onSave, "저장 중"))).toBe(false);
    expect(hasSuccess(render(onSave))).toBe(true);
    expect(hasSuccess(render(onSave, "자동 저장 중단"))).toBe(false);
  });

  it.each([false, "reject"] as const)("reports failed persistence (%s), retains the draft, and permits retry", async result => {
    const onSave = vi.fn<Save>();
    if (result === false) onSave.mockResolvedValueOnce(false);
    else onSave.mockRejectedValueOnce(new Error("storage unavailable"));
    await saveButton(render(onSave)).onClick!();
    const failed = render(onSave, "저장 실패");
    expect(hasSuccess(failed)).toBe(false);
    expect(failed.some(props => props.role === "alert" && String(props.children).includes("저장하지 못했습니다"))).toBe(true);
    expect(saveButton(failed).disabled).toBe(false);
    onSave.mockResolvedValueOnce(true);
    await saveButton(failed).onClick!();
    expect(onSave.mock.calls[1]).toEqual(onSave.mock.calls[0]);
    expect(onSave.mock.calls[1][0]).toContainEqual({ id: "D3", status: "미확정", detail: "작성 중 메모" });
    expect(hasSuccess(render(onSave))).toBe(true);
  });
});

const storedDraft: UnifiedDecisionDraft = {
  kind: "decision", id: "D3", status: "미확정", detail: "저장된 기준", origin: "stored",
};
const suggestedDraft: UnifiedGenericDraft = {
  kind: "generic", id: null, candidateKey: "failure-route", name: "실패 시 담당자 검토",
  category: "예외·확인 기준", applicability: "적용 여부 미확정", status: "미확정",
  detail: "", source: "", step: "", origin: "candidate", provenance: "이전 단계 근거",
};

describe("AX unified rule candidate refresh", () => {
  it("refreshes source-only changes, removes untouched obsolete candidates and retains unrelated decision edits", async () => {
    harness.derive = source => source.sourceNote === "새 진단"
      ? [storedDraft, { ...suggestedDraft, candidateKey: "new-condition", name: "새 처리 조건" }]
      : [storedDraft, suggestedDraft];
    const onSave = vi.fn<Save>().mockResolvedValue(true);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    render(onSave).find(props => props.value === "저장된 기준")!.onChange!({ target: { value: "저장 전 수정 기준" } });
    const nextDiagnosis = { ...diagnosis, sourceNote: "새 진단" };
    const refreshed = render(onSave, "이 브라우저에 저장됨", nextDiagnosis);
    expect(refreshed.some(props => props.children === "새 처리 조건")).toBe(true);
    expect(refreshed.some(props => props.children === suggestedDraft.name)).toBe(false);
    expect(refreshed.some(props => props.value === "저장 전 수정 기준")).toBe(true);
    await saveButton(refreshed).onClick!();
    expect(onSave.mock.calls[0][0]).toContainEqual({ id: "D3", status: "미확정", detail: "저장 전 수정 기준" });
    expect(onSave.mock.calls[0][1]).toEqual([]);
  });

  it("keeps a candidate expanded and preserves edits when name and provenance change under the same candidateKey", async () => {
    harness.derive = source => [{
      ...suggestedDraft,
      ...(source.sourceNote === "새 진단" ? { name: "새 진단의 표시 이름", provenance: "새 업무 단계 근거" } : {}),
    }];
    const onSave = vi.fn<Save>().mockResolvedValue(true);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    const initialFields = render(onSave).find(props => typeof props.value === "object" && props.value !== null)!;
    initialFields.onChange!({ detail: "사용자 처리 기준", name: "사용자가 바꾼 이름" });
    const refreshed = render(onSave, "이 브라우저에 저장됨", { ...diagnosis, sourceNote: "새 진단" });
    expect(refreshed.some(props => props["aria-expanded"] === true)).toBe(true);
    expect(refreshed.some(props => props.children === "사용자가 바꾼 이름")).toBe(true);
    expect(refreshed.some(props => typeof props.value === "object" && props.value !== null
      && (props.value as UnifiedGenericDraft).detail === "사용자 처리 기준")).toBe(true);
    await saveButton(refreshed).onClick!();
    expect(onSave.mock.calls[0][1]).toEqual([expect.objectContaining({ name: "사용자가 바꾼 이름", detail: "사용자 처리 기준" })]);
  });

  it("keeps untouched candidate expansion stable even when its displayed name and provenance change", async () => {
    harness.derive = source => [{
      ...suggestedDraft,
      ...(source.sourceNote === "새 진단" ? { name: "변경된 후보 이름", provenance: "다른 출처" } : {}),
    }];
    const onSave = vi.fn<Save>().mockResolvedValue(true);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    const refreshed = render(onSave, "이 브라우저에 저장됨", { ...diagnosis, sourceNote: "새 진단" });
    expect(refreshed.some(props => props.children === "변경된 후보 이름")).toBe(true);
    expect(refreshed.some(props => props["aria-expanded"] === true)).toBe(true);
    await saveButton(refreshed).onClick!();
    expect(onSave.mock.calls[0][1]).toEqual([]);
  });

  it("retains touched candidates no longer derived and in-progress direct user input", async () => {
    harness.derive = source => source.sourceNote === "새 진단" ? [] : [suggestedDraft];
    const onSave = vi.fn<Save>().mockResolvedValue(true);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    render(onSave).find(props => typeof props.value === "object" && props.value !== null)!.onChange!({ detail: "보존할 사용자 기준" });
    await render(onSave).find(props => props.children === "+ 규칙 추가")!.onClick!();
    render(onSave).find(props => typeof props.value === "object" && props.value !== null)!.onChange!({ name: "작성 중인 직접 규칙" });
    const refreshed = render(onSave, "이 브라우저에 저장됨", { ...diagnosis, sourceNote: "새 진단" });
    expect(refreshed.some(props => props.children === suggestedDraft.name)).toBe(true);
    expect(refreshed.some(props => props.children === "작성 중인 직접 규칙")).toBe(true);
    expect(refreshed.some(props => props.children === "신규")).toBe(true);
  });

  it("refreshes candidates after a failed optimistic save without losing exact input or treating the echo as persisted", async () => {
    harness.derive = source => [
      { ...storedDraft, detail: source.decisionPoints?.find(point => point.id === "D3")?.detail ?? storedDraft.detail },
      ...(source.sourceNote === "새 진단" ? [{ ...suggestedDraft, candidateKey: "new-condition", name: "새 처리 조건" }] : [suggestedDraft]),
    ];
    const gate = Promise.withResolvers<boolean>();
    const onSave = vi.fn<Save>(() => gate.promise);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    render(onSave).find(props => props.value === "작성 중 메모")!.onChange!({ target: { value: "  실패 후 보존 메모  " } });
    const pending = saveButton(render(onSave)).onClick!();
    const echo = { ...diagnosis, decisionPoints: [{ id: "D3" as const, status: "미확정" as const, detail: "실패 후 보존 메모" }] };
    render(onSave, "저장 중", echo);
    gate.resolve(false); await pending;
    render(onSave, "저장 실패", echo);
    const refreshed = render(onSave, "저장 실패", { ...echo, sourceNote: "새 진단" });
    expect(refreshed.some(props => props.value === "  실패 후 보존 메모  ")).toBe(true);
    expect(refreshed.some(props => props.children === "새 처리 조건")).toBe(true);
    expect(refreshed.some(props => props.children === suggestedDraft.name)).toBe(false);
  });

  it("preserves a locally deleted stored rule through source-only re-diagnosis", async () => {
    const savedRule: GenericRule = {
      id: "R8", name: "사용자 저장 규칙", category: "처리·판단 기준", applicability: "적용", status: "확정", detail: "사용자 기준",
    };
    harness.derive = () => [{ ...suggestedDraft, ...savedRule, source: "", step: "", origin: "stored" }];
    const onSave = vi.fn<Save>().mockResolvedValue(true);
    await render(onSave, "이 브라우저에 저장됨", diagnosis, [savedRule]).find(props => props["aria-expanded"] === false)!.onClick!();
    const deleteButton = render(onSave, "이 브라우저에 저장됨", diagnosis, [savedRule])
      .find(props => Array.isArray(props.children) && props.children.includes(" 이 규칙 삭제"))!;
    await deleteButton.onClick!();
    const refreshed = render(onSave, "이 브라우저에 저장됨", { ...diagnosis, sourceNote: "새 진단" }, [savedRule]);
    expect(refreshed.some(props => props.children === savedRule.name)).toBe(false);
    await saveButton(refreshed).onClick!();
    expect(onSave.mock.calls[0][1]).toEqual([]);
  });


  it.each([false, true])("distinguishes empty candidates with sufficient context=%s without claiming completion or readiness", ready => {
    harness.derive = () => [];
    harness.derivationReady = ready;
    const tree = render(vi.fn<Save>().mockResolvedValue(true));
    expect(tree.some(props => props.children === (ready ? "확인할 규칙 없음" : "진단 정보 부족"))).toBe(true);
    expect(tree.some(props => typeof props.children === "string" && props.children.includes(ready
      ? "추가로 확인할 업무 규칙이 도출되지 않았습니다" : "규칙 필요 여부를 판단하지 못했습니다"))).toBe(true);
    expect(tree.some(props => typeof props.children === "string" && /0\/0|100%|구현 가능(?:합니다|함)|검토 완료/u.test(props.children))).toBe(false);
  });
});

describe("AX failed generic candidate save", () => {
  it("refreshes newly diagnosed conditions without duplicating a partial optimistic stored echo or discarding the touched candidate", async () => {
    harness.derive = (source, saved) => [
      ...(saved?.length ? saved.map(rule => ({
        kind: "generic" as const, ...rule, detail: rule.detail ?? "", source: rule.source ?? "", step: rule.step ?? "", origin: "stored" as const,
      })) : [suggestedDraft]),
      ...(source.sourceNote === "새 진단" ? [{ ...suggestedDraft, candidateKey: "new-condition", name: "새 처리 조건" }] : []),
    ];
    const gate = Promise.withResolvers<boolean>();
    const onSave = vi.fn<Save>(() => gate.promise);
    await render(onSave).find(props => props["aria-expanded"] === false)!.onClick!();
    render(onSave).find(props => typeof props.value === "object" && props.value !== null)!
      .onChange!({ detail: "  실패해도 보존할 처리 기준  " });
    const pending = saveButton(render(onSave)).onClick!();
    const optimisticRules = onSave.mock.calls[0][1];
    render(onSave, "저장 중", diagnosis, optimisticRules);
    gate.resolve(false); await pending;
    const failed = render(onSave, "저장 실패", diagnosis, optimisticRules);
    expect(failed.filter(props => props.children === suggestedDraft.name)).toHaveLength(1);
    expect(failed.filter(props => props.children === "제안")).toHaveLength(1);
    const refreshed = render(onSave, "저장 실패", { ...diagnosis, sourceNote: "새 진단" }, optimisticRules);
    expect(refreshed.filter(props => props.children === suggestedDraft.name)).toHaveLength(1);
    expect(refreshed.some(props => props.children === "새 처리 조건")).toBe(true);
    expect(refreshed.some(props => typeof props.value === "object" && props.value !== null
      && (props.value as UnifiedGenericDraft).detail === "  실패해도 보존할 처리 기준  ")).toBe(true);
    expect(refreshed.some(props => props.children === "0/2 완료")).toBe(true);
  });
});
