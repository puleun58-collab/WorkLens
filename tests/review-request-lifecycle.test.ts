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
/** What the result area currently shows: a found outcome's text, an error message, or nothing. */
function shown(): string | null {
  const section = render().find((node) => node.props["aria-label"] === "검토 결과");
  if (!section) return null;
  const tree = nodes(section);
  const data = tree.find((node) => node.props.data)?.props.data as { text?: string } | undefined;
  if (data) return `found:${data.text}`;
  const failure = tree.find((node) => node.props.className === "law-search-error");
  return failure ? `error:${failure.props.children as string}` : "other";
}
function sourceChanged() { return render().some((node) => node.props["data-review-stale"] === "true"); }
function hasButton(label: string) { return render().some((node) => node.props.children === label); }
function selectFile(id: string) { (field("research-file").onValueChange as (value: string) => void)(id); }
function source(mode: "file" | "text") { (field("review-document-source").onValueChange as (value: string) => void)(mode); }
function changeText(text: string) {
  (field("research-document").onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
}
function changeTask(task: string) { (field("research-task").onValueChange as (value: string) => void)(task); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function error(message: string) { return Response.json({ error: { message } }, { status: 500 }); }
function found(text: string) { return Response.json({ data: { found: true, task: "document_review", text, markers: [] } }); }
function sent(index: number) { return JSON.parse(vi.mocked(fetch).mock.calls[index][1]!.body as string) as { text?: string; document?: { id: string } }; }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }
async function fixture(id: string) {
  const document = await parseDocument({ fileId: id, fileName: `${id}.docx`, bytes: createDocxParagraphs(["용역 계약서", "당사자는 조건을 협의하여 업무를 진행한다."]) });
  const workspaceFile: WorkspaceFile = { id, name: `${id}.docx`, kind: "docx", size: 1, status: "ready", metadata: document.metadata, warnings: [] };
  return { workspaceFile, file: reviewFileFor(document, workspaceFile.name) };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; files = []; vi.resetAllMocks(); vi.mocked(runInWorker).mockRejectedValue(new Error("Unexpected worker request")); vi.stubGlobal("fetch", vi.fn(async () => error("조회 실패"))); render(); });

describe("review request lifecycle", () => {
  it("keeps each file's outcome for that file only; retry re-runs the shown file", async () => {
    const a = await fixture("a"), b = await fixture("b");
    files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file).mockResolvedValueOnce(b.file);
    submit(); await settle();
    expect(shown()).toBe("error:조회 실패");
    selectFile("b");
    expect(shown()).toBeNull();
    expect(hasButton("다시 시도")).toBe(false);
    vi.mocked(fetch).mockImplementation(async () => found("B 결과"));
    submit(); await settle();
    expect(sent(1).document!.id).toBe(b.file.document.id);
    expect(shown()).toBe("found:B 결과");
    selectFile("a");
    expect(shown()).toBe("error:조회 실패");
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(sent(2).document!.id).toBe(a.file.document.id);
    expect(runInWorker).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("found:B 결과");
    selectFile("b"); expect(shown()).toBe("found:B 결과");
  });

  it("switching mode hides, never deletes or re-runs, the other mode's result", async () => {
    const a = await fixture("a"); files = [a.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file);
    vi.mocked(fetch).mockImplementation(async (_url, init) => found(JSON.parse(init!.body as string).document ? "파일 결과" : "입력 결과"));
    submit(); await settle();
    expect(shown()).toBe("found:파일 결과");
    source("text");
    expect(shown()).toBeNull();
    expect(sourceChanged()).toBe(false);
    const text = "직접 입력한 계약서 내용입니다. 당사자는 조건을 확인하여 업무를 진행합니다.";
    changeText(text);
    expect(shown()).toBeNull();
    submit(); await settle();
    expect(shown()).toBe("found:입력 결과");
    for (let round = 0; round < 2; round++) {
      source("file"); expect(shown()).toBe("found:파일 결과");
      source("text"); expect(shown()).toBe("found:입력 결과");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(runInWorker).toHaveBeenCalledTimes(1);
    expect(field("research-document").value).toBe(text);
  });

  it("worker read failure retains A rather than the later-selected B on retry", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockRejectedValueOnce(new Error("worker read failure")).mockResolvedValueOnce(a.file);
    submit(); await settle();
    selectFile("b"); expect(hasButton("다시 시도")).toBe(false);
    selectFile("a");
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(runInWorker).toHaveBeenLastCalledWith({ kind: "review-source", fileId: "a" });
    expect(sent(0).document!.id).toBe(a.file.document.id);
  });

  it("a same-id replacement keeps the historical result with a source notice and blocks retry", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file); submit(); await settle();
    expect(sourceChanged()).toBe(false);
    files = [{ ...a.workspaceFile }, b.workspaceFile];
    expect(shown()).toBe("error:조회 실패");
    expect(button("다시 시도").disabled).toBe(true);
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runInWorker).toHaveBeenCalledTimes(1);
  });

  it("a deleted file's result is not shown for the remaining file", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file); submit(); await settle();
    files = [b.workspaceFile];
    expect(shown()).toBeNull();
    expect(sourceChanged()).toBe(false);
    expect(hasButton("다시 시도")).toBe(false);
  });

  it("direct input shows its result only for the reviewed text, trimmed at the edges", async () => {
    source("text");
    const a = "\n계약서 내용 A를 검토합니다. 당사자는 조건을 확인합니다.\n";
    const sameLength = a.replace("A", "B");
    changeText(a); submit(); await settle();
    expect(shown()).toBe("error:조회 실패");
    changeText(sameLength); expect(shown()).toBeNull();
    expect(sourceChanged()).toBe(false);
    changeText(a.trim()); expect(shown()).toBe("error:조회 실패");
    vi.mocked(fetch).mockImplementation(async () => found("A 결과"));
    (button("다시 시도").onClick as () => void)(); await settle();
    expect(sent(1).text).toBe(a);
    expect(shown()).toBe("found:A 결과");
    vi.mocked(fetch).mockImplementation(async () => found("B 결과"));
    changeText(sameLength); submit(); await settle();
    expect(sent(2).text).toBe(sameLength);
    expect(shown()).toBe("found:B 결과");
    changeText(a); expect(shown()).toBeNull();
  });

  it("pending file preparation blocks duplicates; leaving the task cancels it and a fresh run works after", async () => {
    const a = await fixture("a"); files = [a.workspaceFile];
    const read = deferred<typeof a.file>();
    vi.mocked(runInWorker).mockImplementationOnce(() => read.promise);
    submit(); submit(); expect(runInWorker).toHaveBeenCalledTimes(1);
    changeTask("full_research");
    read.resolve(a.file); await settle();
    expect(fetch).not.toHaveBeenCalled();
    changeTask("document_review");
    expect(shown()).toBeNull();
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file);
    vi.mocked(fetch).mockImplementation(async () => found("새 결과"));
    submit(); await settle();
    expect(runInWorker).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("found:새 결과");
  });

  it("deleting A during worker preparation stops the request", async () => {
    const a = await fixture("a"), b = await fixture("b"); files = [a.workspaceFile, b.workspaceFile];
    const read = deferred<typeof a.file>();
    vi.mocked(runInWorker).mockImplementationOnce(() => read.promise);
    submit(); files = [b.workspaceFile]; render(); read.resolve(a.file); await settle();
    expect(fetch).not.toHaveBeenCalled(); expect(runInWorker).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
  });

  it("a superseded direct request arriving late never overrides the newer text's result", async () => {
    source("text");
    const older = deferred<Response>(), newer = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = "실행 당시 계약서 내용을 검토합니다. 당사자는 조건을 확인합니다.";
    const second = "수정된 계약서 내용을 검토합니다. 당사자는 조건을 확인합니다.";
    changeText(first); submit(); submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    changeText(second); submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    newer.resolve(found("새 입력 결과")); await settle();
    expect(shown()).toBe("found:새 입력 결과");
    older.resolve(found("이전 입력 결과")); await settle();
    expect(shown()).toBe("found:새 입력 결과");
    changeText(first); expect(shown()).toBeNull();
  });

  it("a file request finishing after the user moved to direct input lands on the file only", async () => {
    const a = await fixture("a"); files = [a.workspaceFile];
    const fileResponse = deferred<Response>();
    vi.mocked(runInWorker).mockResolvedValueOnce(a.file);
    vi.mocked(fetch).mockImplementationOnce(() => fileResponse.promise).mockImplementationOnce(async () => found("입력 결과"));
    submit(); await settle();
    expect(button("문서 검토 중…").disabled).toBe(true);
    source("text");
    changeText("직접 입력한 계약서 내용입니다. 당사자는 조건을 확인하여 업무를 진행합니다.");
    expect(hasButton("문서 검토 중…")).toBe(false);
    submit(); await settle();
    expect(shown()).toBe("found:입력 결과");
    fileResponse.resolve(error("파일 검토 실패")); await settle();
    expect(shown()).toBe("found:입력 결과");
    source("file");
    expect(shown()).toBe("error:파일 검토 실패");
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
