import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import type * as ServerAiClient from "@/client/server-ai-client";
import { emptyAxState, type AxStateV2 } from "@/lib/ax/types";
import { outputFixture, taskFixture } from "./fixtures/ax";

// DESIGN §6 S10: a diagnosis the server returned but storage failed to persist is never shown as complete.
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, updated: false,
  stored: undefined as unknown, screen: undefined as unknown,
  updateAndSave: vi.fn(), update: vi.fn(), replace: vi.fn(), diagnoseAx: vi.fn(),
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
  useEffect() {},
  useLayoutEffect() {},
  useId: () => "ax-test-id",
}));
vi.mock("@/client/use-ax-state", () => ({
  useAxState: () => ({
    state: harness.screen, update: harness.update, updateAndSave: harness.updateAndSave, getState: () => harness.screen,
    replace: harness.replace, ready: true, saveStatus: "이 브라우저에 저장됨", loadNotice: "", externalChange: false, storageProtection: "writable",
  }),
}));
vi.mock("@/client/server-ai-client", async importOriginal => ({
  ...await importOriginal<typeof ServerAiClient>(),
  diagnoseAx: harness.diagnoseAx,
}));
vi.mock("@/client/document-client", () => ({ runInWorker: vi.fn() }));
vi.mock("@/client/ax-store", async importOriginal => ({
  ...await importOriginal<typeof import("@/client/ax-store")>(),
  saveAxQuestionFile: vi.fn(), loadAxQuestionFile: vi.fn(), deleteAxQuestionFile: vi.fn(), deleteAxQuestionFiles: vi.fn(),
}));
import { AxDiagnosisView } from "@/components/ax/AxDiagnosisView";

type NodeProps = { children?: ReactNode; role?: string; onDiagnose?: () => void };
function nodes(node: ReactNode): NodeProps[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<NodeProps>(node)) return [];
  return [node.props, ...nodes(node.props.children)];
}
function render() {
  let tree: NodeProps[];
  do {
    harness.cursor = 0;
    harness.updated = false;
    tree = nodes(AxDiagnosisView());
  } while (harness.updated);
  return tree;
}
const statusText = (tree: NodeProps[]) => tree.filter(props => props.role === "status").map(props => String(props.children));
async function settle() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.updated = false;
  const state: AxStateV2 = { ...emptyAxState(), tasks: [taskFixture("task-1")], selectedTaskId: "task-1", step: 2 };
  harness.screen = state;
  harness.stored = structuredClone(state);
  harness.update.mockReset(); harness.replace.mockReset();
  harness.diagnoseAx.mockReset().mockResolvedValue(outputFixture());
  // Storage write failure: the updater runs against the latest state, but nothing is persisted.
  harness.updateAndSave.mockReset().mockImplementation(async (updater: (current: AxStateV2) => AxStateV2) => {
    updater(harness.screen as AxStateV2);
    return false;
  });
});

describe("AX diagnosis persistence failure", () => {
  it("S10 reports the save failure and never shows completion or writes the diagnosis", async () => {
    const card = render().find(props => props.onDiagnose);
    expect(card).toBeDefined();
    card!.onDiagnose!();
    await settle();
    const messages = statusText(render());

    expect(harness.diagnoseAx).toHaveBeenCalledTimes(1);
    expect(harness.updateAndSave).toHaveBeenCalledTimes(1);
    expect(messages.some(text => text.startsWith("진단 결과 저장 실패 · "))).toBe(true);
    expect(messages.some(text => text.includes("업무 진단을 완료했습니다"))).toBe(false);
    // No other write path stored the diagnosis.
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect((harness.stored as AxStateV2).tasks[0].diagnosis).toBeUndefined();
    expect((harness.screen as AxStateV2).tasks[0].diagnosis).toBeUndefined();
  });

  it("shows completion only when the same diagnosis is persisted", async () => {
    harness.updateAndSave.mockImplementation(async (updater: (current: AxStateV2) => AxStateV2) => {
      harness.stored = updater(harness.screen as AxStateV2);
      return true;
    });
    render().find(props => props.onDiagnose)!.onDiagnose!();
    await settle();
    const messages = statusText(render());
    expect(messages.some(text => text.includes("업무 진단을 완료했습니다"))).toBe(true);
    expect((harness.stored as AxStateV2).tasks[0].diagnosis?.poc).toEqual(outputFixture().poc);
  });
});
