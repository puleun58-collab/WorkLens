import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { UnifiedRulesSection } from "@/components/ax/AxUnifiedRules";
import { diagnosisFixture } from "./fixtures/ax";
import type { AxDiagnosis, DecisionPoint, GenericRule } from "@/lib/ax/types";

// Drive the section's save handler and rendered feedback with controlled persistence.
const harness = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (value: unknown) => {
      harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value;
    }];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
}));
type NodeProps = {
  children?: ReactNode; onClick?: () => Promise<void>; disabled?: boolean; role?: string;
  "aria-expanded"?: boolean; value?: string; onChange?: (event: { target: { value: string } }) => void;
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
function render(onSave: Save, saveStatus = "이 브라우저에 저장됨", currentDiagnosis: AxDiagnosis = diagnosis) {
  harness.cursor = 0;
  return nodes(UnifiedRulesSection({ diagnosis: currentDiagnosis, onSave, saveStatus }));
}
const saveButton = (tree: NodeProps[]) => tree.find(props => props.children === "저장")!;
const hasSuccess = (tree: NodeProps[]) => tree.some(props => props.children === "업무 규칙을 저장했습니다.");
beforeEach(() => { harness.slots = []; harness.cursor = 0; });

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
