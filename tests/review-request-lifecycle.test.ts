import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { WorkspaceFile } from "@/client/protocol";
import { parseDocument } from "@/lib/parsers";
import { reviewFileFor } from "@/lib/law-review-source";
import { createDocxParagraphs } from "./fixtures";
import Home from "@/app/page";
import { POLISH_TEXT_MAX_CHARS } from "@/lib/polish/text-input";

// Exercise the view's event handlers and rerenders without a DOM/server. Children
// are left as elements; this is a request lifecycle test, not a browser assertion.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
  useEffect: () => undefined, useLayoutEffect: (fn: () => void) => fn(), useSyncExternalStore: () => true,
}));
vi.mock("@/client/document-client", () => ({ runInWorker: vi.fn() }));
import { LegalResearch } from "@/components/research/LegalResearch";
import { runInWorker } from "@/client/document-client";

function nodes(root: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (!root || typeof root !== "object" || !("props" in root)) return [];
  const element = root as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
let files: WorkspaceFile[];
function render() {
  hooks.cursor = 0;
  const root = LegalResearch({ initialTask: "document_review", workspace: { files, selected: [] } });
  return nodes(root);
}
function field(id: string) {
  const tree = render();
  if (id === "review-document-source") return tree.find((node) => node.props["aria-label"] === "문서 입력 방식")!.props;
  if (id === "research-file" || id === "research-task") return tree.find((node) => node.props.onValueChange && nodes(node.props.children as ReactNode).some((child) => child.props.id === id))!.props;
  return tree.find((node) => node.props.id === id)!.props;
}
function button(label: string) { return render().find((node) => node.props.children === label)!.props; }
function submit() {
  const form = render().find((node) => node.props.onSubmit)!;
  (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
}
function stale() { return render().some((node) => node.props["data-review-stale"] === "true"
  || (node.props.className === "research-meta" && typeof node.props.children === "string"
    && /지금 선택한 문서가 아닌|삭제되었거나/.test(node.props.children))); }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }
async function fixture(id: string) {
  const document = await parseDocument({ fileId: id, fileName: `${id}.docx`, bytes: createDocxParagraphs(["용역 계약서", "당사자는 조건을 협의하여 업무를 진행한다."]) });
  const workspaceFile: WorkspaceFile = { id, name: `${id}.docx`, kind: "docx", size: 1, status: "ready", metadata: document.metadata, warnings: [] };
  return { workspaceFile, file: reviewFileFor(document, workspaceFile.name) };
}
const failure = () => Promise.resolve(Response.json({ error: { message: "조회 실패" } }, { status: 500 }));
const success = () => Promise.resolve(Response.json({ data: { found: true, task: "document_review", text: "검토 완료", markers: [] } }));
beforeEach(() => { hooks.values = []; hooks.cursor = 0; files = []; vi.resetAllMocks(); vi.mocked(runInWorker).mockRejectedValue(new Error("Unexpected worker request")); vi.stubGlobal("fetch", vi.fn(failure)); render(); });

describe("review request lifecycle", () => {
  it("A fails, B is selected, retry sends A; ordinary execution sends B", async () => {
    const a = await fixture("a"), b = await fixture("b");
    files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file).mockResolvedValueOnce(b.file);
    submit(); await settle();
    (field("research-file").onValueChange as (value: string) => void)("b");
    expect(stale()).toBe(true);
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).document.id).toBe(a.file.document.id);
    expect(runInWorker).toHaveBeenCalledTimes(1);
    submit(); await settle();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string).document.id).toBe(b.file.document.id);
  });

  it("worker read failure retains A rather than using selected B on retry", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockRejectedValueOnce(new Error("worker read failure")).mockResolvedValueOnce(a.file);
    submit(); await settle();
    expect(runInWorker).toHaveBeenCalledTimes(1);
    (field("research-file").onValueChange as (value: string) => void)("b");
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(runInWorker).toHaveBeenLastCalledWith({ kind: "review-source", fileId: "a" });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).document.id).toBe(a.file.document.id);
  });

  it.each(["delete", "replace"])("%s original A blocks retry and never executes B", async (mode) => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file); submit(); await settle();
    files = mode === "delete" ? [b.workspaceFile] : [{ ...a.workspaceFile }, b.workspaceFile];
    expect(stale()).toBe(true);
    expect(button("다시 시도").disabled).toBe(true);
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runInWorker).toHaveBeenCalledTimes(1);
  });

  it("direct retry uses failed text; presentation toggles are not stale; success clears failure", async () => {
    (field("review-document-source").onValueChange as (value: string) => void)("text");
    const change = (text: string) => (field("research-document").onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
    const a = "\n계약서 내용 A를 검토합니다. 당사자는 조건을 확인합니다.\n";
    const b = "계약서 내용 B를 검토합니다. 당사자는 내용을 협의합니다.";
    change(a); submit(); await settle(); change(b); expect(stale()).toBe(true);
    vi.mocked(fetch).mockImplementation(success);
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).text).toBe(a);
    expect(stale()).toBe(true);
    change(a.trim()); expect(stale()).toBe(false);
    change(a); expect(stale()).toBe(false);
    (field("run-review-document_review-sources").onCheckedChange as (value: boolean) => void)(true);
    expect(stale()).toBe(false);
    change(b); submit(); await settle(); expect(stale()).toBe(false);
    expect(render().some((node) => node.props.children === "다시 시도")).toBe(false);
  });

  it("pending file preparation belongs to A, prevents duplicate execution, and cancelled tasks cannot publish it", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    let release!: (value: typeof a.file) => void;
    vi.mocked(runInWorker).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    submit(); submit(); expect(runInWorker).toHaveBeenCalledTimes(1);
    (field("research-file").onValueChange as (value: string) => void)("b");
    release(a.file); await settle(); expect(stale()).toBe(true);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).document.id).toBe(a.file.document.id);
    vi.mocked(runInWorker).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    submit();
    (field("research-task").onValueChange as (value: string) => void)("full_research");
    release(b.file); await settle(); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deleting A during worker preparation stops the request and blocks retry", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    let release!: (value: typeof a.file) => void;
    vi.mocked(runInWorker).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    submit(); files = [b.workspaceFile]; render(); release(a.file); await settle();
    expect(stale()).toBe(true); expect(button("다시 시도").disabled).toBe(true);
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(fetch).not.toHaveBeenCalled(); expect(runInWorker).toHaveBeenCalledTimes(1);
  });

  it("direct response arriving after an edit remains attached to its request snapshot", async () => {
    (field("review-document-source").onValueChange as (value: string) => void)("text");
    const change = (text: string) => (field("research-document").onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
    change("실행 당시 계약서 내용을 검토합니다. 당사자는 조건을 확인합니다.");
    let release!: (value: Awaited<ReturnType<typeof success>>) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    submit(); submit(); change("수정된 계약서 내용을 검토합니다. 당사자는 조건을 확인합니다.");
    release(await success()); await settle(); expect(stale()).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function home() { hooks.cursor = 0; return nodes(Home()); }
function homeField(label: string) { return home().find((node) => node.props["aria-label"] === label)!.props; }
function paste(text: string) {
  (homeField("윤문할 텍스트 입력").onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
}
describe("polish text action preflight", () => {
  beforeEach(() => {
    hooks.values = []; hooks.cursor = 0;
    const navigate = home().find((node) => node.props.onNavigate)!.props.onNavigate as (value: string) => void;
    navigate("Polish");
    (homeField("윤문 입력 방식").onValueChange as (value: string) => void)("text");
  });

  it.each([0, 1, POLISH_TEXT_MAX_CHARS - 1, POLISH_TEXT_MAX_CHARS, POLISH_TEXT_MAX_CHARS + 1])("length %i has the correct action state", (size) => {
    paste("가".repeat(size));
    expect(homeField("윤문 실행").disabled).toBe(size === 0 || size > POLISH_TEXT_MAX_CHARS);
    expect(homeField("윤문할 텍스트 입력").maxLength).toBeUndefined();
  });

  it("whitespace is disabled; an over-limit action is disabled and lowering it reenables execution", async () => {
    paste("   "); expect(homeField("윤문 실행").disabled).toBe(true);
    paste("가".repeat(POLISH_TEXT_MAX_CHARS + 1));
    expect(homeField("윤문 실행").disabled).toBe(true);
    expect(home().some((node) => node.props["data-over"] === "true")).toBe(true);
    // Even an imperative invocation keeps the existing internal defense.
    await (homeField("윤문 실행").onClick as () => Promise<void>)();
    expect(fetch).not.toHaveBeenCalled();
    expect(runInWorker).not.toHaveBeenCalled();
    paste("가".repeat(POLISH_TEXT_MAX_CHARS));
    expect(homeField("윤문 실행").disabled).toBe(false);
  });

  it("busy text polishing disables the action", async () => {
    paste("업무 보고서를 확인하여 회신해 주시기 바랍니다.");
    let release!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = (homeField("윤문 실행").onClick as () => Promise<void>)();
    const action = home().find((node) => node.props["aria-label"] === "윤문 실행")!;
    expect(action.props.disabled).toBe(true);
    release(Response.json({ error: { code: "AI_UNAVAILABLE", message: "사용 불가" } }, { status: 503 }));
    await pending;
    expect(homeField("윤문 실행").disabled).toBe(false);
  });

  it("file mode still depends on the selected file, independently of pasted text length", async () => {
    paste("가".repeat(POLISH_TEXT_MAX_CHARS + 1));
    (homeField("윤문 입력 방식").onValueChange as (value: string) => void)("file");
    const a = await fixture("a");
    vi.mocked(runInWorker).mockResolvedValueOnce(a.workspaceFile);
    const event = { target: { files: [{ name: "a.docx", arrayBuffer: async () => new ArrayBuffer(0) }], value: "a.docx" } };
    (homeField("작업 파일 선택").onChange as (event: unknown) => void)(event);
    await settle();
    expect(homeField("윤문 실행").disabled).toBe(true);
    (homeField("a.docx 선택").onCheckedChange as () => void)();
    expect(homeField("윤문 실행").disabled).toBe(false);
  });
});
