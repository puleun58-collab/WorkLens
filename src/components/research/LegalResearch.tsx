"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  AMENDMENT_SCENARIOS, DISPUTE_DOMAINS, EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_DOCUMENT_MAX_CHARS, LAW_RESEARCH_DOCUMENT_MIN_CHARS,
  LAW_RESEARCH_ERROR, LAW_RESEARCH_NAME_MAX_CHARS, LAW_RESEARCH_QUERY_MAX_CHARS, LAW_RESEARCH_TASKS, lawResearchOutcome, lawResearchRequestFor,
  type AmendmentScenario, type DisputeDomain, type LawResearchData, type LawResearchDraft, type LawResearchOutcome,
  type IssueEvidence, type LawCurrency, type LawResearchRequest, type LawResearchTask, type OrdinanceRegionResult, type ResearchInterpretation,
} from "@/lib/law-research";
import { isSupportingSection, researchResult, type ResearchDecision, type ResearchSection } from "@/lib/law-research-parse";
import { lawDisplayText } from "@/lib/law-display";
import { orderByRelevance, type ResearchEnrichment } from "@/lib/research-relevance";
import { STATUS_TITLE, type ResearchStatus } from "@/lib/research-status";
import { LawTextBlock } from "./LawTextBlock";
import { ContractReviewResult, FileReviewExcluded } from "./ContractReviewResult";
import { SourceToggleSummary } from "./SourceToggleSummary";
import type { ReviewableFiles } from "./LawSearch";
import type { WorkspaceFile } from "@/client/protocol";
import { runInWorker } from "@/client/document-client";
import { reviewRequestFor, type ReviewFile } from "@/lib/law-review-source";
import { readReviewPreferences, resolveReviewPreferences, type ReviewPreferences } from "@/client/review-preferences";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import "./legal-analysis.css";

interface TaskResult {
  request: LawResearchRequest;
  outcome: LawResearchOutcome | null;
  preferences?: ReviewPreferences;
  loading: boolean;
  /** 문서 검토 of a workspace file: its segments' sources and what part of it was reviewed. */
  file?: ReviewFile;
  /** The exact workspace entry used when starting this file review (not a later replacement). */
  workspaceFile?: WorkspaceFile;
}

const FILE_READ_ERROR = "작업 파일을 읽지 못했습니다. 파일을 다시 올린 뒤 실행하세요.";

const TASK_HELP: Record<LawResearchTask, { description: string; placeholder: string }> = {
  full_research: { description: "질문이나 상황을 바탕으로 관련 법령·판례·결정례를 함께 조사합니다.", placeholder: "예: 회사에서 업무와 관련해 지속적으로 모욕을 당했는데 어떤 법적 기준을 살펴봐야 하나요?" },
  law_system: { description: "한 법령의 법률·시행령·시행규칙 관계를 함께 확인합니다.", placeholder: "예: 개인정보 보호법 제38조와 시행령의 관계" },
  action_basis: { description: "처분 또는 허가의 근거 조문과 확인 가능한 불복 자료를 찾습니다.", placeholder: "예: 식품위생법상 영업정지의 근거와 요건" },
  dispute_prep: { description: "분쟁 상황을 설명하고 관련 법령·판례·결정례를 함께 조사합니다.", placeholder: "예: 부당해고 구제 신청 관련 판례와 결정례" },
  amendment_track: { description: "특정 법령의 개정 이력과 두 시점의 조문 차이를 조사합니다.", placeholder: "예: 근로기준법 제60조 개정 내용" },
  ordinance_compare: { description: "두 지역의 같은 주제 조례를 찾아 확인된 조문 원문을 비교합니다.", placeholder: "예: 주차장 설치 기준" },
  procedure_detail: { description: "절차의 근거 조문과 제출 서식을 찾아 확인합니다.", placeholder: "예: 행정심판 청구 절차와 제출서류" },
  document_review: { description: "입력한 문서의 조항별 쟁점과 확인된 근거를 검토합니다.", placeholder: "계약서 또는 약관 등의 내용을 붙여 넣으세요." },
};

/** 법제처 status plus the article's 시행일; only `current` means in force today. */
const CURRENCY_LABEL: Record<LawCurrency, string> = {
  current: "현행",
  upcoming: "시행 예정",
  not_current: "현행 아님",
  unconfirmed: "현행 여부 미확인",
};
const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";

const subscribeNothing = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function LegalResearch({ workspace, initialTask = "full_research" }: { workspace?: ReviewableFiles; initialTask?: LawResearchTask }) {
  const files = workspace?.files ?? [];
  const [savedPreferences, setSavedPreferences] = useState<ReviewPreferences | null>(null);
  const [preferenceOverride, setPreferenceOverride] = useState<Partial<ReviewPreferences>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const preferences = useMemo(() => resolveReviewPreferences(savedPreferences, preferenceOverride), [savedPreferences, preferenceOverride]);
  const documentSource = preferences.documentSource;
  // Browser storage exists only after hydration; read it once, during the first client render that can.
  const hydrated = useSyncExternalStore(subscribeNothing, clientSnapshot, serverSnapshot);
  if (hydrated && !preferencesReady) {
    const loaded = readReviewPreferences();
    setSavedPreferences(loaded.preferences);
    setSettingsError(loaded.error);
    setPreferencesReady(true);
  }
  const [chosenFile, setChosenFile] = useState<string>("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [task, setTask] = useState<LawResearchTask>(initialTask);
  const [draft, setDraft] = useState<LawResearchDraft>(EMPTY_RESEARCH_DRAFT);
  const [results, setResults] = useState<Partial<Record<LawResearchTask, TaskResult>>>({});
  const requests = useRef(new Map<LawResearchTask, AbortController>());

  useEffect(() => {
    const pending = requests.current;
    return () => pending.forEach((controller) => controller.abort());
  }, []);

  const run = useCallback(async (request: LawResearchRequest, file?: ReviewFile, workspaceFile?: WorkspaceFile, runPreferences = preferences) => {
    requests.current.get(request.task)?.abort();
    const controller = new AbortController();
    requests.current.set(request.task, controller);
    setResults((current) => ({ ...current, [request.task]: { request, preferences: { ...runPreferences }, outcome: null, loading: true, ...(file ? { file } : {}), ...(workspaceFile ? { workspaceFile } : {}) } }));
    let outcome: LawResearchOutcome;
    try {
      const response = await fetch("/api/law/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      outcome = lawResearchOutcome(response.ok, body);
    } catch {
      outcome = { kind: "error", message: LAW_RESEARCH_ERROR };
    }
    if (controller.signal.aborted) return;
    requests.current.delete(request.task);
    setResults((current) => ({ ...current, [request.task]: { request, preferences: { ...runPreferences }, outcome, loading: false, ...(file ? { file } : {}), ...(workspaceFile ? { workspaceFile } : {}) } }));
  }, [preferences]);

  /**
   * Reviews one workspace file: the worker builds the bounded request from the parsed document
   * (nothing is uploaded again), and a file with no reviewable text is reported, not sent.
   */
  const runFile = useCallback(async (fileId: string) => {
    const task = "document_review";
    const workspaceFile = workspace?.files.find((entry) => entry.id === fileId);
    if (!workspaceFile) return;
    let file: ReviewFile;
    try {
      file = await runInWorker({ kind: "review-source", fileId });
    } catch {
      setResults((current) => ({ ...current, [task]: { request: { task, text: "" }, outcome: { kind: "error", message: FILE_READ_ERROR }, loading: false } }));
      return;
    }
    // Only the projected DTO is sent: text, positions and identity, never the selector's hints.
    const request: LawResearchRequest = reviewRequestFor(file.document);
    if (file.coverage.status === "excluded") {
      requests.current.get(task)?.abort();
      setResults((current) => ({ ...current, [task]: { request, outcome: null, loading: false, file, workspaceFile } }));
      return;
    }
    await run(request, file, workspaceFile);
  }, [run, workspace?.files]);

  /** Leaving a task cancels its in-flight chain; finished results stay for when the user comes back. */
  function changeTask(next: LawResearchTask) {
    const pending = requests.current.get(task);
    if (pending) {
      pending.abort();
      requests.current.delete(task);
      setResults((current) => {
        const copy = { ...current };
        delete copy[task];
        return copy;
      });
    }
    setTask(next);
  }
  const shellEntry = useRef(initialTask);
  useEffect(() => {
    if (shellEntry.current === initialTask) return;
    shellEntry.current = initialTask;
    const pendingTasks = [...requests.current.keys()];
    requests.current.forEach((controller) => controller.abort());
    requests.current.clear();
    setResults((current) => {
      const copy = { ...current };
      pendingTasks.forEach((pendingTask) => { delete copy[pendingTask]; });
      return copy;
    });
    setTask(initialTask);
    setPreferenceOverride({});
  }, [initialTask]);

  const update = <K extends keyof LawResearchDraft>(key: K, value: LawResearchDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const current = results[task];
  const loading = current?.loading === true;
  const request = lawResearchRequestFor(task, draft);
  const regionNames = [draft.region1.trim(), draft.region2.trim()];
  const regionError = task === "ordinance_compare" && (regionNames.some((region) => !region) || regionNames[0] === regionNames[1]);
  const isDocument = task === "document_review";
  const reversedDates = task === "amendment_track" && draft.scenario === "time_travel" && draft.fromDate && draft.toDate && draft.fromDate > draft.toDate;
  // Selected workspace files first; one of them is reviewed at a time, never several merged.
  const selectedIds = workspace?.selected ?? [];
  const reviewable = [...files].sort((left, right) => Number(selectedIds.includes(right.id)) - Number(selectedIds.includes(left.id)));
  const fileId = reviewable.some((file) => file.id === chosenFile) ? chosenFile : reviewable[0]?.id ?? "";
  const fromFile = isDocument && documentSource === "file";
  const canRun = fromFile ? Boolean(fileId) : Boolean(request);
  const resultFile = current?.file;
  const presentFile = resultFile && files.find((entry) => entry.id === resultFile.fileId);
  const staleFileReview = Boolean(resultFile && (!presentFile || presentFile !== current?.workspaceFile
    || resultFile.document.id !== `document:${presentFile.id}` || !resultFile.document.version
    || resultFile.sources.length !== resultFile.document.segments.length
    || resultFile.sources.some((source) => source.fileId !== presentFile.id
      || source.documentId !== resultFile.document.id || source.documentVersion !== resultFile.document.version)));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || !canRun) return;
    if (fromFile) void runFile(fileId);
    else if (request) void run(request);
  }

  /** Adds through the workspace's own upload, then selects the last file that parsed. */
  async function addFiles(list: FileList | null) {
    if (!workspace?.addFiles || !list?.length) return;
    setUploadErrors([]);
    const results = await workspace.addFiles(list);
    const added = results.flatMap((result) => "id" in result ? [result.id] : []);
    if (added.length) setChosenFile(added.at(-1)!);
    setUploadErrors(results.flatMap((result) => "error" in result ? [result.error] : []));
  }

  const runButton = <Button type="submit" className="law-search-button" disabled={!canRun || loading || !preferencesReady}>
    {loading ? (isDocument ? "문서 검토 중…" : "리서치 중…") : "실행"}
  </Button>;
  const resultDisplay = isDocument ? <div className="research-source-option">
    <Field className="research-source-row inline-flex flex-row items-center" disabled={!preferencesReady || loading}>
      <FieldLabel htmlFor={`run-review-${task}-sources`}>출처 펼쳐 보기</FieldLabel>
      <Switch id={`run-review-${task}-sources`} checked={preferences.expandSources}
        disabled={!preferencesReady || loading}
        onCheckedChange={(expandSources) => setPreferenceOverride((current) => ({ ...current, expandSources }))} />
    </Field>
    {settingsError && <p className="law-search-error" role="alert">{settingsError}</p>}
  </div> : null;
  return <div className="legal-analysis legal-research">
    <div className={`research-workspace${isDocument ? " is-document" : ""}`}>
    <div className="research-workspace-main">
    <form className={`legal-analysis-form${isDocument ? " research-document-workarea" : ""}`} onSubmit={submit} aria-label={isDocument ? "문서 검토 입력" : "종합 리서치 입력"}>
      <div className="legal-analysis-fields legal-research-options">
        <Field><FieldLabel htmlFor="research-task">리서치 유형</FieldLabel>
          <Select items={LAW_RESEARCH_TASKS} value={task} onValueChange={(value) => { if (value) changeTask(value as LawResearchTask); }}>
            <SelectTrigger id="research-task"><SelectValue /></SelectTrigger>
            <SelectPopup>{LAW_RESEARCH_TASKS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>
        {task === "dispute_prep" && <Field><FieldLabel htmlFor="research-domain">분야</FieldLabel>
          <Select items={DISPUTE_DOMAINS} value={draft.domain} onValueChange={(value) => update("domain", (value ?? "") as DisputeDomain | "")}>
            <SelectTrigger id="research-domain"><SelectValue /></SelectTrigger>
            <SelectPopup>{DISPUTE_DOMAINS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>}
        {task === "amendment_track" && <Field><FieldLabel htmlFor="research-scenario">추적 방식</FieldLabel>
          <Select items={[{ value: "", label: "자동" }, ...AMENDMENT_SCENARIOS]} value={draft.scenario} onValueChange={(value) => update("scenario", (value ?? "") as AmendmentScenario | "")}>
            <SelectTrigger id="research-scenario"><SelectValue /></SelectTrigger>
            <SelectPopup><SelectItem value="">자동</SelectItem>{AMENDMENT_SCENARIOS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>}
      </div>
      <p className="legal-research-description">{TASK_HELP[task].description}</p>

      {isDocument ? <div className="research-document-input" role="group" aria-labelledby="research-document-label">
        <p id="research-document-label" className="research-document-label">검토할 문서</p>
        <RadioGroup className="mb-4 flex-row gap-5" aria-label="문서 입력 방식" value={documentSource}
          onValueChange={(source) => { if (source === "file" || source === "text") setPreferenceOverride((current) => ({ ...current, documentSource: source })); }}>
          {(["file", "text"] as const).map((source) => <label key={source} className="inline-flex items-center gap-2 text-sm">
            <Radio value={source} /><span>{source === "file" ? "작업 파일" : "직접 입력"}</span>
          </label>)}
        </RadioGroup>
        {fromFile ? <>
          <div className={reviewable.length ? "research-file-workarea is-populated" : `dropzone${workspace?.uploading ? " busy" : ""}${dropActive ? " drag-active" : ""}`}
            onDragEnter={(event) => { if (!reviewable.length && workspace?.addFiles && !workspace.uploading) { event.preventDefault(); setDropActive(true); } }}
            onDragOver={(event) => { if (!reviewable.length && workspace?.addFiles && !workspace.uploading) { event.preventDefault(); setDropActive(true); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
            onDrop={(event) => { if (!reviewable.length && workspace?.addFiles) { event.preventDefault(); setDropActive(false); if (!workspace.uploading) void addFiles(event.dataTransfer.files); } }}>
            {reviewable.length === 0 && <>
              <span className="upload-icon" aria-hidden="true"><Upload /></span>
              <div className="dropzone-copy"><strong>검토할 문서를 추가하세요</strong></div>
            </>}
          <div className={reviewable.length ? "research-file-row" : "drop-actions"}>
            {reviewable.length > 0 &&
              <Select items={reviewable.map((file) => ({ value: file.id, label: file.name }))} value={fileId} onValueChange={(value) => setChosenFile(value ?? "")}>
                <SelectTrigger id="research-file" aria-labelledby="research-document-label"><SelectValue /></SelectTrigger>
                <SelectPopup>{reviewable.map((file) => <SelectItem key={file.id} value={file.id}>{file.name}</SelectItem>)}</SelectPopup>
              </Select>}
            {workspace?.addFiles && <>
              <input ref={fileInput} type="file" multiple hidden accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label="검토할 작업 파일 추가"
                onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
              <Button type="button" variant={reviewable.length ? "outline" : "default"} className="research-file-add" onClick={() => fileInput.current?.click()} disabled={workspace.uploading}>
                {workspace.uploading ? "분석 중…" : <><Plus aria-hidden="true" />파일 추가</>}
              </Button>
            </>}
            {files.length > 0 && runButton}
          </div>
          </div>
          {uploadErrors.map((message) => <p key={message} className="law-search-error" role="alert">{message}</p>)}
        </> : <>
          <Field><Textarea id="research-document" aria-label="검토할 문서 내용" value={draft.text} rows={10} maxLength={LAW_RESEARCH_DOCUMENT_MAX_CHARS} placeholder={TASK_HELP.document_review.placeholder} onChange={(event) => update("text", event.target.value)} aria-describedby="research-document-help" /></Field>
          <p id="research-document-help" className="legal-analysis-help">
            <span className="legal-analysis-count">{draft.text.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_DOCUMENT_MAX_CHARS.toLocaleString("ko-KR")}자 · 최소 {LAW_RESEARCH_DOCUMENT_MIN_CHARS}자</span>
          </p>
        </>}
      </div> : <>
        <Field><FieldLabel htmlFor="research-query">질문 또는 검색어</FieldLabel>
        <Textarea id="research-query" value={draft.query} rows={3} maxLength={LAW_RESEARCH_QUERY_MAX_CHARS} placeholder={TASK_HELP[task].placeholder} onChange={(event) => update("query", event.target.value)} aria-describedby="research-query-help"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></Field>
        <p id="research-query-help" className="legal-analysis-help legal-research-help-row">
          {task === "amendment_track" && <label className="legal-research-switch">
            전체 개정 이력 포함
            <Switch checked={draft.includeHistory} onCheckedChange={(checked) => update("includeHistory", checked)} />
          </label>}
          <span className="legal-analysis-count">{draft.query.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_QUERY_MAX_CHARS.toLocaleString("ko-KR")}자</span>
        </p>
      </>}

      {task === "law_system" && <label htmlFor="research-articles" className="legal-research-single">관련 조문 (선택)
        <Input id="research-articles" type="text" value={draft.articles} placeholder="예: 제38조, 제39조" onChange={(event) => update("articles", event.target.value)} />
      </label>}
      {task === "ordinance_compare" && <label htmlFor="research-parent-law" className="legal-research-single">관련 상위 법령 (선택)
        <Input id="research-parent-law" type="text" value={draft.parentLaw} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder="요청에 법령이 명시된 경우에만 입력하세요. 예: 주차장법" onChange={(event) => update("parentLaw", event.target.value)} />
      </label>}
      {task === "ordinance_compare" && <>
        <div className="legal-analysis-fields legal-research-dates legal-research-regions">
          {(["region1", "region2"] as const).map((key, index) => <label key={key} htmlFor={`research-region-${index}`}>비교 지역 {index + 1}
            <Input id={`research-region-${index}`} type="text" value={draft[key]} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder={index ? "예: 서울특별시" : "예: 인천광역시"}
              onChange={(event) => update(key, event.target.value)} />
          </label>)}
        </div>
      </>}
      {task === "amendment_track" && <>
        {draft.scenario === "time_travel" && <div className="legal-analysis-fields legal-research-dates">
          <label htmlFor="research-from">시작일
            <Input id="research-from" type="date" value={draft.fromDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("fromDate", event.target.value)} />
          </label>
          <label htmlFor="research-to">종료일
            <Input id="research-to" type="date" value={draft.toDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("toDate", event.target.value)} />
          </label>
          {reversedDates && <p className="law-search-error" role="alert">시작일은 종료일보다 늦을 수 없습니다.</p>}
        </div>}
      </>}

      {resultDisplay}

      {!fromFile && <div className={`legal-analysis-actions${task === "ordinance_compare" ? " legal-research-action-row" : ""}`}>
        {task === "ordinance_compare" && (() => {
          // Guidance until both regions are filled; the same region twice is a real input error.
          const duplicate = Boolean(regionNames[0]) && regionNames[0] === regionNames[1];
          return regionError ? <p className="legal-research-input-note" data-state={duplicate ? "error" : "hint"} role={duplicate ? "alert" : undefined}>
            {duplicate ? "같은 지역을 두 번 입력했습니다. 서로 다른 비교 지역 2곳을 입력하세요." : "서로 다른 비교 지역 2곳을 입력하세요. 비교할 주제는 위 질문에 입력하면 됩니다."}
          </p> : null;
        })()}
        {runButton}
      </div>}
    </form>
    </div>

    {current && <section className="legal-analysis-result" aria-labelledby="research-result-heading" aria-busy={loading}>
      <h2 id="research-result-heading">{isDocument ? "검토 결과" : "리서치 결과"}</h2>
      {isDocument && resultFile && !current.loading && (staleFileReview
        ? <p className="research-meta" role="status">삭제되었거나 현재 작업 파일의 출처·버전과 일치하지 않는 검토 결과입니다. 위치는 검토 당시 기록이며 현재 파일로 이동할 수 없습니다.</p>
        : fromFile && fileId !== resultFile.fileId
          ? <p className="research-meta" role="status">지금 선택한 문서가 아닌 {resultFile.document.name}의 검토 결과입니다.</p>
          : null)}
      {current.loading ? <p className="law-search-note" role="status">{isDocument ? "문서 검토 중…" : "리서치 중…"} 여러 자료를 함께 조회하므로 시간이 걸릴 수 있습니다.</p>
        : current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <Button type="button" variant="link" className="law-search-link" onClick={() => void (current.request.task === "document_review" && "text" in current.request && !current.request.text
            ? runFile(fileId) : run(current.request, current.file, current.workspaceFile, current.preferences))}>다시 시도</Button>
        </div>
        : current.file && !current.outcome ? <FileReviewExcluded file={current.file} />
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status">
          <header className="research-overview">
            <span className="research-eyebrow">{LAW_RESEARCH_TASKS.find((item) => item.value === current.request.task)?.label}</span>
            <h3 className="legal-analysis-title">{STATUS_TITLE.none}</h3>
            {current.request.task !== "document_review" && <div className="research-original"><span>입력한 질문</span><p>{current.request.query}</p></div>}
            {current.request.task === "full_research" && current.outcome.data.interpretation?.original === current.request.query
              && <ResearchUnderstanding interpretation={current.outcome.data.interpretation} />}
            {current.request.task === "full_research" && !current.outcome.data.interpretation
              && <p className="research-meta research-uninterpreted">{UNINTERPRETED_NOTE}</p>}
            <p className="research-caution">조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다.</p>
          </header>
        </div>
        : current.outcome?.kind === "found" ? current.outcome.data.review
          ? <ContractReviewResult review={current.outcome.data.review} file={current.file} expandSources={current.preferences?.expandSources} />
          : <ResearchResult data={current.outcome.data} request={current.request} expandSources={false} />
        : null}
    </section>}
    </div>
  </div>;
}

/** Search hits shown before the list folds; the rest of what the response contains stays one click away. */
const DECISION_PREVIEW = 3;
const ANNEX_PREVIEW = 5;

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = /^(\d{4})(\d{2})(\d{2})$/u.exec(value) ?? /^(\d{4})[.-](\d{1,2})[.-](\d{1,2})$/u.exec(value);
  if (!parts) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

/** Heading without the MCP's bracketed status markers, which the partial notice already reports. */
function sectionHeading(section: ResearchSection): string {
  const heading = lawDisplayText(section.heading?.replace(/\s*\[[^\]]*\]/gu, "")
    .replace(/^\s*(?:(?:STEP|단계)\s*\d+|(?:OPEN\s+)?API\s*(?:응답|오류|조회)?)\s*[:.)-]?\s*/iu, "").trim());
  const dates = /^Time Travel\s*[—–-]\s*(.+?)\s*\((\d{8})\s*↔\s*(\d{8})\)$/u.exec(heading);
  if (!dates) return heading;
  const from = formatDate(dates[2]);
  const to = formatDate(dates[3]);
  return `두 시점의 조문 비교 · ${dates[1]}${from && to ? ` (${from} → ${to})` : ""}`;
}

/** Source excerpts remain legible; agent-facing diagnostics do not become reader-facing claims. */
function readerText(text: string): string {
  return lawDisplayText(text.split(/\r?\n/u).filter((line) =>
    !/^\s*(?:(?:STEP\s*\d+|(?:OPEN\s+)?API\b)[\s:.)-]|\[(?:EXTERNAL_API_ERROR|REQUEST_TIMEOUT)\]|HTTP\s+\d{3}\b|검색\s*보정(?:\s*시도)?\s*[:：]|재시도(?:\s*제안)?\s*[:：]|힌트\s*[:：]|💡\s*다음\s*[:：]|사유\s*[:：]\s*\[(?:FAILED|NOT_FOUND)|⚠️\s*이 섹션은 조회 실패|특정\s*조문\s*조회\s*:\s*get_|.*법제처\s*API는\s*공백)/iu.test(line),
  ).join("\n"));
}

type ResearchGroup = "statutes" | "decisions" | "change" | "regional" | "forms" | "other";
const GROUP_LABELS: Record<Exclude<LawResearchTask, "document_review">, Partial<Record<ResearchGroup, string>>> = {
  full_research: { statutes: "관련 법령·조문", decisions: "관련 판례·결정례", other: "참고 자료" },
  law_system: { statutes: "법령·조문", other: "법률·시행령·시행규칙 관계", decisions: "참고 결정" },
  action_basis: { statutes: "처분·허가의 법령 근거", decisions: "관련 불복·해석 자료", other: "추가 근거" },
  dispute_prep: { statutes: "관련 법령", decisions: "판례·결정례·재결례", other: "쟁송 참고 자료" },
  amendment_track: { change: "시점별 개정 내용", statutes: "관련 조문", other: "개정 참고 자료" },
  ordinance_compare: { regional: "지역별 자치법규", statutes: "상위 법령·조문", other: "비교 참고 자료" },
  procedure_detail: { forms: "제출 서식", statutes: "절차의 법령 근거", other: "절차·비용 자료" },
};
const GROUP_ORDER: Record<Exclude<LawResearchTask, "document_review">, ResearchGroup[]> = {
  full_research: ["statutes", "decisions", "other", "change", "regional", "forms"],
  law_system: ["other", "statutes", "decisions", "change", "regional", "forms"],
  action_basis: ["statutes", "decisions", "other", "change", "regional", "forms"],
  dispute_prep: ["decisions", "statutes", "other", "change", "regional", "forms"],
  amendment_track: ["change", "statutes", "other", "decisions", "regional", "forms"],
  ordinance_compare: ["regional", "statutes", "other", "decisions", "change", "forms"],
  procedure_detail: ["other", "forms", "statutes", "decisions", "change", "regional"],
};

function groupOf(section: ResearchSection, task: LawResearchTask): ResearchGroup {
  const heading = section.heading ?? "";
  if (section.kind === "law_articles") return task === "ordinance_compare"
    && (/조례|자치법규/u.test(heading) || section.articles?.some((article) => /조례|자치법규/u.test(article.law))) ? "regional" : "statutes";
  if (section.kind === "decision_search" || /판례|해석례|재결|심판례|결정례/u.test(heading)) return "decisions";
  if (section.kind === "annex" || /별표|서식/u.test(heading)) return "forms";
  if (task === "amendment_track" && /개정|신구|시점|이력|Time Travel/u.test(heading)) return "change";
  if (task === "ordinance_compare" && /자치법규|조례|지역/u.test(heading)) return "regional";
  if (/법령|조문|상위법/u.test(heading)) return "statutes";
  return "other";
}

/** Per-issue outcome in the reader's words; `none` is "not found in this search", never "no law". */
const ISSUE_STATUS_LABEL: Record<IssueEvidence["status"], string> = {
  found: "근거 확인",
  none: "직접 관련 근거 미확인",
  failed: "자료 확인 실패",
  timeout: "조회 미완료",
};

/** 입력한 질문 → 이렇게 이해했어요 → 살펴볼 쟁점: sibling blocks, each opened by the same rule; empty ones are not rendered. */
function ResearchUnderstanding({ interpretation, evidence = [] }: { interpretation: ResearchInterpretation; evidence?: readonly IssueEvidence[] }) {
  // The model often restates the question verbatim; showing it twice adds nothing.
  const situation = interpretation.situation.replace(/\s+/gu, "") !== interpretation.original.replace(/\s+/gu, "") ? interpretation.situation : "";
  const issues = interpretation.issues.map((issue) => issue.label.trim()).filter(Boolean);
  const note = interpretation.followUp || interpretation.uncertainty;
  // Once the issues were searched, the list says how far each one got (확인한 근거 below is grouped the same way).
  const statusOf = (label: string) => evidence.find((entry) => entry.label?.trim() === label);
  const assessed = issues.some((issue) => statusOf(issue));
  return <>
    {(situation || note) && <div className="research-original research-understanding">
      <span>이렇게 이해했어요</span>
      {situation && <p>{situation}</p>}
      {/* One short, concrete request; the generic uncertainty only when there is no specific question to ask. */}
      {interpretation.followUp
        ? <p className="research-meta"><b>추가로 필요한 정보</b> {interpretation.followUp}</p>
        : interpretation.uncertainty && <p className="research-meta">{interpretation.uncertainty}</p>}
    </div>}
    {issues.length > 0 && <div className={`research-original research-issues${assessed ? " is-assessed" : ""}`}>
      <span>{assessed ? "확인한 쟁점" : "살펴볼 쟁점"}</span>
      <ul>{issues.map((issue, index) => {
        const entry = statusOf(issue);
        return <li key={index}>
          <span className="research-issue-label">{issue}</span>
          {entry && <span className="research-issue-status" data-status={entry.status}>{ISSUE_STATUS_LABEL[entry.status]}</span>}
        </li>;
      })}</ul>
    </div>}
  </>;
}

function DecisionList({ entries }: { entries: ResearchDecision[] }) {
  return <ul className="research-hits">{entries.map((entry) => {
    const meta = [entry.caseNumber && `사건번호 ${entry.caseNumber}`, entry.body, formatDate(entry.date)].filter(Boolean).join(" · ");
    return <li key={entry.id}>
      <strong>{lawDisplayText(entry.title ?? entry.caseNumber ?? "제목 없음")}</strong>
      {meta && <span className="research-meta">{lawDisplayText(meta)}</span>}
    </li>;
  })}</ul>;
}

/** Articles WorkLens looked up itself because a question term is in their title. */
function SupplementView({ supplement, hasArticles, excluded }: { supplement: NonNullable<ResearchEnrichment["supplement"]>; hasArticles: boolean; excluded?: Set<string> }) {
  const articles = supplement.articles.filter((article) => !excluded?.has(`${article.law}\u0000${article.jo}`));
  if (!articles.length) {
    if (supplement.articles.length || hasArticles || supplement.status === "not_searched") return null;
    return <div className="legal-analysis-section" data-kind="supplement" data-status={supplement.status}>
      <p className="research-meta">{supplement.status === "failed" ? "관련 조문 추가 조회에 실패했습니다." : "관련 법령을 충분히 확인하지 못했습니다."}</p>
    </div>;
  }
  return <div className="legal-analysis-section" data-kind="supplement" data-status={supplement.status}>
    <h3>질문 용어가 제목에 있는 조문 <span className="research-meta">{articles.length}건</span></h3>
    <p className="research-meta">질문의 용어가 조문 제목에 있는 조문을 법제처에서 추가로 조회했습니다.</p>
    <ul className="research-hits">{articles.map((article) => {
      const effective = formatDate(article.effectiveDate);
      return <li key={`${article.law}-${article.jo}`}>
        <strong>{article.law} {article.jo} {article.title}</strong>
        <LawTextBlock className="legal-analysis-lines" text={article.excerpt} />
        {effective && <span className="research-meta">출처 시행일 {effective}</span>}
      </li>;
    })}</ul>
  </div>;
}

/** Shown when the question could not be split into issues this time (e.g. the AI service was busy). */
const UNINTERPRETED_NOTE = "질문을 쟁점별로 나누지 못해 입력한 문장으로 검색했습니다. 잠시 후 다시 실행하면 쟁점별로 확인할 수 있습니다.";

/** Why an issue has no confirmed source: nothing addressed it, or its lookups could not answer. */
const ISSUE_GAP: Record<IssueEvidence["status"], string> = {
  found: "표시할 수 있는 근거 원문이 없습니다.",
  none: "직접 관련된 근거를 찾지 못했습니다.",
  failed: "자료를 불러오지 못해 확인하지 못했습니다.",
  timeout: "조회를 마치지 못해 확인하지 못했습니다.",
};

const STATUS_NOTE: Record<Exclude<ResearchSection["status"], "available">, string> = {
  not_found: "자료 없음",
  failed: "불러오지 못했습니다",
  timeout: "조회를 마치지 못했습니다",
};

/** Top notice only for sections that failed or timed out; an empty search is a normal result. */
function partialNotice(sections: readonly ResearchSection[]): string | null {
  const failed = sections.some((section) => section.status === "failed");
  const timeout = sections.some((section) => section.status === "timeout");
  if (failed && timeout) return "일부 자료를 확인하지 못해 현재 조회된 결과만 표시합니다.";
  if (failed) return "일부 자료를 불러오지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다.";
  if (timeout) return "일부 자료 조회가 완료되지 않아 확인된 결과만 표시합니다.";
  return null;
}

function ResearchSectionView({ section, task, relevance, retried }: {
  section: ResearchSection; task: LawResearchData["task"]; relevance?: ResearchEnrichment["precedents"];
  retried?: ResearchEnrichment["interpretations"];
}) {
  const heading = sectionHeading(section);
  const className = `legal-analysis-section${section.unavailable ? " is-unavailable" : ""}`;
  if (section.status !== "available") {
    // The MCP's reason/hint lines address the calling agent; the reader gets one sentence (raw text stays in 원문 보기).
    const found = section.status === "not_found" && retried?.entries.length ? retried : undefined;
    // An empty or unavailable section takes one line; the heading and its state read together.
    if (!found) {
      return <p className={`${className} research-empty-line`} data-kind={section.kind} data-status={section.status}>
        {heading ? `${heading} · ` : ""}{STATUS_NOTE[section.status]}
      </p>;
    }
    return <div className={className} data-kind={section.kind} data-status={section.status}>
      {heading && <h3>{heading}<span className="research-meta"> {found.entries.length}건</span></h3>}
      <p className="research-meta">질문의 핵심어로 다시 찾은 자료입니다. 사건과의 관련성은 원문으로 확인해 주세요.</p>
      <DecisionList entries={found.entries} />
    </div>;
  }
  if (section.kind === "law_articles" && section.articles) {
    const articles = section.articles;
    const items = (from: number, to: number) => <ul className="research-hits">{articles.slice(from, to).map((article, index) => {
      const excerpt = readerText(article.excerpt);
      const effective = formatDate(article.effective);
      return <li key={`${article.law}-${article.jo}-${from + index}`}>
        <strong>{article.law} {article.jo}{article.title ? ` ${article.title}` : ""}</strong>
        {excerpt && <LawTextBlock className="legal-analysis-lines" text={excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt} />}
        {excerpt.length > 600 && <details className="law-detail-source research-more"><SourceToggleSummary label="조문 발췌 전체 보기" openLabel="조문 발췌 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>}
        {(effective || article.ministry) && <span className="research-meta">{[effective && `출처 시행일 ${effective}`, article.ministry].filter(Boolean).join(" · ")}</span>}
      </li>;
    })}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>관련 조문 <span className="research-meta">{articles.length}건</span></h3>
      <p className="research-meta">조문 발췌입니다. 실제 적용 여부는 사실관계와 법령 원문으로 확인해 주세요.</p>
      {items(0, 3)}
      {articles.length > 3 && <details className="law-detail-source research-more"><SourceToggleSummary label={`나머지 조문 ${articles.length - 3}건 보기`} openLabel="나머지 조문 접기" />{items(3, articles.length)}</details>}
    </div>;
  }
  if (section.kind === "decision_search" && section.decisions) {
    const { entries } = section.decisions;
    const rated = relevance && entries.some((entry) => relevance[entry.id]);
    const ordered = rated ? orderByRelevance(entries, relevance) : entries;
    // Cases whose 판시사항/opening does not address the question are kept, folded, never deleted.
    const shown = rated ? ordered.filter((entry) => relevance![entry.id]?.rank !== "low") : ordered;
    const low = rated ? ordered.filter((entry) => relevance![entry.id]?.rank === "low") : [];
    const rest = shown.slice(DECISION_PREVIEW);
    return <div className={className} data-kind={section.kind}>
      <h3>{heading} <span className="research-meta">{entries.length}건</span></h3>
      {rated && <p className="research-meta">판시사항을 기준으로 질문과 관련성이 높은 판례를 먼저 보여줍니다.</p>}
      {shown.length > 0
        ? <DecisionList entries={shown.slice(0, DECISION_PREVIEW)} />
        : <p className="research-meta research-empty">관련성이 높은 판례를 충분히 확인하지 못했습니다.</p>}
      {rest.length > 0 && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`판례 ${rest.length}건 더 보기`} openLabel="판례 접기" />
        <DecisionList entries={rest} />
      </details>}
      {low.length > 0 && <details className="law-detail-source research-more" data-relevance="low">
        <SourceToggleSummary label={`참고: 직접 관련성이 확인되지 않은 판례 ${low.length}건`} openLabel="참고 판례 접기" />
        <DecisionList entries={low} />
      </details>}
    </div>;
  }
  if (section.kind === "annex" && section.annex) {
    const { total, entries } = section.annex;
    // For 절차·서식 the forms are the answer; elsewhere they are reference material.
    const preview = task === "procedure_detail" ? 10 : ANNEX_PREVIEW;
    const list = (items: typeof entries) => <ul className="research-hits">{items.map((item, index) => <li key={`${item.title}-${index}`}>
      <strong>{item.title}</strong>{item.law && <span className="research-meta">{item.law}</span>}
    </li>)}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>{heading} <span className="research-meta">{total !== undefined && total > entries.length ? `전체 ${total.toLocaleString("ko-KR")}건 중 ${entries.length}건` : `${entries.length}건`}</span></h3>
      {list(entries.slice(0, preview))}
      {entries.length > preview && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`목록 펼쳐보기 · ${entries.length - preview}건 더`} openLabel="목록 접기" />
        {list(entries.slice(preview))}
      </details>}
    </div>;
  }
  const text = readerText(section.lines.join("\n"));
  const lines = text.split("\n");
  const preview = lines.slice(0, 7).join("\n").slice(0, 800);
  const steps = task === "procedure_detail" && /절차|진행|신청|청구/u.test(heading) ? lines.flatMap((line) => {
    const match = /^\s*(\d{1,2})[.)]\s+(.{2,200})\s*$/u.exec(line);
    return match ? [{ number: match[1], text: match[2] }] : [];
  }) : [];
  const hierarchy = task === "law_system" && /3단 비교|법령 체계/u.test(heading) ? lines.flatMap((line) => {
    const match = /^\s*\[(법률|시행령|시행규칙)\]\s*(.+)$/u.exec(line);
    return match ? [{ level: match[1], content: match[2] }] : [];
  }) : [];
  return <div className={className} data-kind={section.kind}>
    {heading && <h3>{heading}</h3>}
    {hierarchy.length > 0 ? <dl className="research-hierarchy">{hierarchy.map((item, index) => <div key={index}><dt>{item.level}</dt><dd>{item.content}</dd></div>)}</dl>
      : steps.length >= 2 ? <ol className="research-steps">{steps.map((step, index) => <li key={`${step.number}-${index}`}>{step.text}</li>)}</ol>
        : text && <LawTextBlock className="legal-analysis-lines" text={text.length > preview.length ? `${preview}…` : preview} />}
    {(hierarchy.length > 0 || steps.length >= 2 || text.length > preview.length) && <details className="law-detail-source research-more"><SourceToggleSummary label="출처 내용 전체 보기" openLabel="출처 내용 접기" /><LawTextBlock className="legal-analysis-raw" text={text} /></details>}
  </div>;
}

/** Only a complete, short sentence from the official body may be shown before opening the source. */
function ordinanceFirstSentence(body: string): string | undefined {
  const sentence = /^\s*([\s\S]*?[.!?。！？])(?=\s|$)/u.exec(body)?.[1].trim();
  return sentence && sentence.length <= 140 ? sentence : undefined;
}

function OrdinanceArticleCell({ article, effective }: {
  article: OrdinanceRegionResult["articles"][number];
  effective?: string;
}) {
  const [open, setOpen] = useState(false);
  const excerpt = ordinanceFirstSentence(article.body);
  const date = formatDate(effective);
  return <div className="research-comparison-article">
    <div className="research-comparison-title"><strong>{article.jo}({article.title})</strong></div>
    {excerpt && <p className="research-comparison-excerpt">원문 발췌 · {excerpt}</p>}
    {date && <span className="research-meta">시행 {date}</span>}
    <Button type="button" variant="link" className="law-search-link research-comparison-toggle" aria-expanded={open}
      onClick={() => setOpen((previous) => !previous)}>{open ? "조문 원문 닫기" : "조문 원문 보기"}</Button>
    {open && <div className="research-comparison-original">
      <p className="research-comparison-original-label">법제처 조문 원문</p>
      <LawTextBlock className="legal-analysis-lines" text={article.body} />
    </div>}
  </div>;
}

function ResearchResult({ data, request, expandSources = false }: { data: LawResearchData; request: LawResearchRequest; expandSources?: boolean }) {
  const result = researchResult(data.text);
  const full = data.task === "full_research";
  const issueEvidence = full ? data.evidence?.issues ?? [] : [];
  const notice = partialNotice(result.sections)
    ?? (full && data.evidence?.searchFailed ? "종합 검색 결과를 불러오지 못해 쟁점별로 확인한 자료만 표시합니다."
      : issueEvidence.some((issue) => issue.status === "failed" || issue.status === "timeout")
        ? "일부 쟁점의 자료를 확인하지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다." : null);
  const interpretation = full && data.interpretation?.original === (request.task === "document_review" ? "" : request.query) ? data.interpretation : undefined;
  const primary = result.sections.filter((section) => !isSupportingSection(section)
    && !/^\s*(?:STEP\s*\d+|(?:OPEN\s+)?API\b)/iu.test(section.heading ?? "")
    && (section.heading || readerText(section.lines.join("\n")))
    && (!full || groupOf(section, data.task) !== "other"));
  const supporting = result.sections.filter(isSupportingSection);
  const articleCount = result.sections.reduce((count, section) => count + (section.articles?.length ?? 0), 0);
  const caseCount = result.sections.reduce((count, section) => count + (section.decisions?.entries.length ?? 0), 0);
  const candidateCount = articleCount + caseCount + (data.enrichment?.supplement?.articles.length ?? 0) + (data.enrichment?.interpretations?.entries.length ?? 0);
  const hasUnparsedCandidates = primary.some((section) => section.status === "available"
    && /statutes|decisions/u.test(groupOf(section, data.task)) && !section.articles?.length && !section.decisions?.entries.length && readerText(section.lines.join("\n")));
  const hasCandidates = candidateCount > 0 || hasUnparsedCandidates;
  const taskGroups = GROUP_ORDER[data.task === "document_review" ? "full_research" : data.task];
  const allArticles = result.sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []);
  const selectedArticleKeys = new Set(full ? (data.evidence?.articles ?? []).map((item) => `${item.law}\u0000${item.jo}`) : []);
  const selectedCaseIds = new Set(full ? data.evidence?.precedents ?? [] : []);
  const sourceArticles = [...allArticles, ...(data.enrichment?.supplement?.articles ?? []).map((article) => ({
    law: article.law, jo: article.jo, title: article.title, excerpt: article.excerpt, effective: article.effectiveDate,
  }))];
  const selectedArticles = [...new Map(sourceArticles.filter((article) => selectedArticleKeys.has(`${article.law}\u0000${article.jo}`) && readerText(article.excerpt))
    .map((article) => [`${article.law}\u0000${article.jo}`, article] as const)).values()];
  // Cases an issue found by its own search are not in the combined answer's text; the server lists them separately.
  const caseEntries = [...result.sections.filter((section) => section.status === "available").flatMap((section) => section.decisions?.entries ?? []),
    ...Object.entries(full ? data.evidence?.precedentEntries ?? {} : {}).map(([id, entry]) => ({ id, ...entry }))];
  // The same case can arrive under two serial ids; it is one case, shown once. `caseOf` maps every id to the one shown.
  const caseOf = new Map<string, string>();
  const casesByKey = new Map<string, (typeof caseEntries)[number]>();
  for (const entry of caseEntries.filter((item) => selectedCaseIds.has(item.id))) {
    const key = entry.caseNumber ? `n\u0000${entry.caseNumber.replace(/\s+/gu, "")}` : `i\u0000${entry.id}`;
    const kept = casesByKey.get(key) ?? entry;
    casesByKey.set(key, kept);
    caseOf.set(entry.id, kept.id);
  }
  const selectedCases = [...casesByKey.values()];
  const evidenceStatus = selectedArticles.length + selectedCases.length ? data.evidence?.status : "unverified";
  const unavailableCount = result.sections.filter((section) => section.status !== "available").length;
  const visibleSelectedKeys = new Set(selectedArticles.map((article) => `${article.law}\u0000${article.jo}`));
  const visibleSelectedCaseIds = new Set(caseOf.keys());
  const candidatePrimary: ResearchSection[] = full ? primary.flatMap((section) => {
    if (section.articles) {
      const articles = section.articles.filter((article) => !visibleSelectedKeys.has(`${article.law}\u0000${article.jo}`));
      return articles.length ? [{ ...section, articles }] : [];
    }
    if (section.decisions) {
      const entries = section.decisions.entries.filter((entry) => !visibleSelectedCaseIds.has(entry.id));
      return entries.length ? [{ ...section, decisions: { ...section.decisions, entries } }] : [];
    }
    return [section];
  }) : primary;
  const comparison = data.task === "ordinance_compare" ? data.comparison : undefined;
  const comparedRegions = comparison?.regions.filter((region) => region.status === "found") ?? [];
  const bothSides = comparison?.topics.filter((topic) => comparison.regions.every((region) => region.articles.some((article) => article.topic === topic))) ?? [];
  // Primary sections that returned source content for this request.
  const available = primary.some((section) => section.status === "available" && readerText(section.lines.join("\n")))
    || Boolean(data.enrichment?.supplement?.articles.length);
  // One status vocabulary for every task, decided by what was actually adopted, never by hit counts.
  const status: ResearchStatus = full
    ? evidenceStatus === "matched" ? notice ? "partial" : "matched" : evidenceStatus === "partial" ? "partial" : hasCandidates ? "weak" : "none"
    : comparison
      ? bothSides.length ? comparedRegions.length === 2 ? "matched" : "partial"
        : comparedRegions.some((region) => region.articles.length) ? "partial" : comparedRegions.length ? "weak" : "none"
      : !available ? "none" : notice || unavailableCount ? "partial" : "matched";

  return <div className="legal-analysis-output" data-task={data.task}>
    <header className="research-overview">
      <span className="research-eyebrow">{LAW_RESEARCH_TASKS.find((item) => item.value === data.task)?.label}</span>
      <h3 className="legal-analysis-title" data-status={status}>{STATUS_TITLE[status]}</h3>
      {request.task !== "document_review" && <div className="research-original"><span>입력한 질문</span><p>{request.query}</p></div>}
      {interpretation && <ResearchUnderstanding interpretation={interpretation} evidence={issueEvidence} />}
      {full && !data.interpretation && <p className="research-meta research-uninterpreted">{UNINTERPRETED_NOTE}</p>}
      <p className="research-caution">{status === "matched" || status === "partial"
        ? `${full ? "확인한 근거는" : "조회한 자료는"} 관련 쟁점을 검토하기 위한 자료이며, 구체적인 사건의 법적 결론을 의미하지 않습니다.`
        : status === "weak" ? "조회된 자료가 질문과 직접 관련되는지 확인되지 않았습니다. 아래 자료는 참고용입니다."
        : "조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다."}</p>
    </header>
    {notice && <p className="legal-research-partial" role="note">{notice}</p>}
    {full && (selectedArticles.length > 0 || selectedCases.length > 0) && <section className="research-group research-selected" aria-label="확인한 근거">
      <h3>확인한 근거</h3>
      <p className="research-meta">질문 쟁점과 내용이 맞는 법제처 자료입니다. 법령의 적용 여부나 판결의 결론까지 확인했다는 뜻은 아닙니다.</p>
      {(() => {
        const articleItem = (article: (typeof selectedArticles)[number]) => {
          const excerpt = readerText(article.excerpt);
          const effective = formatDate(article.effective);
          const currency = data.evidence?.articles?.find((item) => item.law === article.law && item.jo === article.jo)?.currency;
          return <li key={`${article.law}-${article.jo}`}>
            <strong>{article.law} {article.jo}{article.title ? ` ${article.title}` : ""}</strong>
            <LawTextBlock className="legal-analysis-lines" text={excerpt.length > 700 ? `${excerpt.slice(0, 700)}…` : excerpt} />
            {excerpt.length > 700 && <details className="law-detail-source research-more"><SourceToggleSummary label="조문 발췌 전체 보기" openLabel="조문 발췌 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>}
            {(effective || currency) && <span className="research-meta" data-currency={currency}>
              {[currency && CURRENCY_LABEL[currency], effective && `시행 ${effective}`].filter(Boolean).join(" · ")}
            </span>}
          </li>;
        };
        const caseName = (entry: (typeof selectedCases)[number]) => lawDisplayText(entry.title ?? entry.caseNumber ?? `판례 ${entry.id}`);
        const caseItem = (entry: (typeof selectedCases)[number]) => {
          const source = supporting.find((section) => section.kind === "detail" && section.lines.some((line) => line.trimStart().startsWith(`[${entry.id}]`)));
          const lines = source?.lines ?? [];
          const start = lines.findIndex((line) => line.trimStart().startsWith(`[${entry.id}]`));
          const next = lines.findIndex((line, index) => index > start && /^\[\d{1,32}\]/u.test(line.trim()));
          const excerpt = readerText(data.evidence?.precedentExcerpts?.[entry.id]
            ?? (start < 0 ? "" : lines.slice(start, next < 0 ? undefined : next).join("\n")));
          const date = formatDate(entry.date);
          return <li key={entry.id}>
            <strong>{caseName(entry)}</strong>
            <span className="research-meta">{[entry.caseNumber && `사건번호 ${entry.caseNumber}`, entry.body, date && `선고·회신 ${date}`].filter(Boolean).join(" · ")}</span>
            {excerpt
              ? <details className="law-detail-source research-more"><SourceToggleSummary label="판시사항 근거 보기" openLabel="판시사항 근거 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>
              : <p className="research-meta">판시사항 발췌를 표시할 수 없습니다. 아래 조회 원자료도 대조해 주세요.</p>}
          </li>;
        };
        // Each source is shown once, under the first issue it supports; a later issue names it instead of repeating it.
        const shown = new Set<string>();
        const groups: IssueEvidence[] = issueEvidence.length ? issueEvidence
          : [{ status: "found", articles: data.evidence?.articles ?? [], precedents: data.evidence?.precedents ?? [] }];
        return groups.map((group, index) => {
          const articles = selectedArticles.filter((article) => group.articles.some((item) => item.law === article.law && item.jo === article.jo));
          const cases = selectedCases.filter((entry) => group.precedents.some((id) => caseOf.get(id) === entry.id));
          const freshArticles = articles.filter((article) => !shown.has(`a\u0000${article.law}\u0000${article.jo}`));
          const freshCases = cases.filter((entry) => !shown.has(`c\u0000${entry.id}`));
          const repeated = [...articles.filter((article) => !freshArticles.includes(article)).map((article) => `${article.law} ${article.jo}`),
            ...cases.filter((entry) => !freshCases.includes(entry)).map(caseName)];
          for (const article of articles) shown.add(`a\u0000${article.law}\u0000${article.jo}`);
          for (const entry of cases) shown.add(`c\u0000${entry.id}`);
          return <div key={index} className="legal-analysis-section research-issue-evidence" data-status={group.status}>
            {group.label && <h3>{group.label}</h3>}
            {freshArticles.length + freshCases.length > 0 && <ul className="research-hits">{freshArticles.map(articleItem)}{freshCases.map(caseItem)}</ul>}
            {repeated.length > 0 && <p className="research-meta">앞 쟁점에서 제시한 근거와 같습니다: {repeated.join(" · ")}</p>}
            {articles.length + cases.length === 0 && <p className="research-meta">{ISSUE_GAP[group.status]}</p>}
          </div>;
        });
      })()}
    </section>}
    {comparison && <section className="research-group" aria-label="조례 대조">
      <h3>지역별 조례 대조</h3>
      <div className="research-table-scroll"><table className="research-comparison">
        <thead><tr><th scope="col">비교 항목</th>{comparison.regions.map((region) => <th key={region.region} scope="col">{region.region}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">적용 조례</th>{comparison.regions.map((region) => <td key={region.region}>
            {region.ordinance ? <><strong>{region.ordinance.name}</strong>
              <span className="research-meta">{[region.ordinance.body, formatDate(region.ordinance.effective) && `시행 ${formatDate(region.ordinance.effective)}`].filter(Boolean).join(" · ")}</span></>
              : <span className="research-meta">{region.status === "failed" ? "조례를 조회하지 못했습니다." : "확인 가능한 관련 조례를 찾지 못했습니다."}</span>}
          </td>)}</tr>
          {comparison.topics.map((topic) => {
            const count = comparison.regions.filter((region) => region.articles.some((article) => article.topic === topic)).length;
            return <tr key={topic}><th scope="row">{topic}<span className="research-comparison-status research-meta">
              {count === 2 ? "두 지역 조문 확인" : count === 1 ? "한 지역 조문 확인" : "확인된 조문 없음"}
            </span></th>{comparison.regions.map((region) => {
              const article = region.articles.find((item) => item.topic === topic);
              return <td key={region.region}>{article
                ? <OrdinanceArticleCell key={`${article.jo}-${article.topic}`} article={article} effective={region.ordinance?.effective} />
                : <span className="research-comparison-missing research-meta">{region.status === "failed" ? "조례 조회에 실패하여 조문을 확인하지 못했습니다."
                  : region.status === "none" ? "관련 조례를 찾지 못해 조문이 없습니다." : "해당 제목의 조문을 확인하지 못했습니다."}</span>}</td>;
            })}</tr>;
          })}
        </tbody>
      </table></div>
      <p className="research-meta">조문은 법제처 자치법규 원문에서 조회했습니다. 나란히 놓인 원문은 차이의 법적 의미를 판단한 결과가 아닙니다.</p>
    </section>}
    {taskGroups.map((group) => {
      const sections = candidatePrimary.filter((section) => groupOf(section, data.task) === group);
      const supplement = group === "statutes" && data.enrichment?.supplement
        && (data.enrichment.supplement.articles.some((article) => !visibleSelectedKeys.has(`${article.law}\u0000${article.jo}`)) || !data.enrichment.supplement.articles.length)
        ? data.enrichment.supplement : undefined;
      if (!sections.length && !supplement) return null;
      return <section key={group} className="research-group" data-group={group}>
        <h3>{GROUP_LABELS[data.task === "document_review" ? "full_research" : data.task][group] ?? "참고 자료"}</h3>
        {sections.map((section, index) => <ResearchSectionView key={index} section={section} task={data.task}
          relevance={data.enrichment?.precedents} retried={/해석례/u.test(section.heading ?? "") ? data.enrichment?.interpretations : undefined} />)}
        {supplement && <SupplementView supplement={supplement} hasArticles={articleCount > 0} excluded={visibleSelectedKeys} />}
      </section>;
    })}
    {supporting.length > 0 && <section className="legal-analysis-section research-supporting">
      <h3>상세 근거</h3>
      {/* The material this answer drew on first; whole-law tables of contents are a browsing aid, so they come after. */}
      {[...supporting].sort((a, b) => Number(a.kind === "law_toc") - Number(b.kind === "law_toc")).map((section, index) => {
        const heading = sectionHeading(section) || "상세 자료";
        const label = section.kind === "law_toc" && section.toc
          ? `${section.toc.law ? `${lawDisplayText(section.toc.law)} ` : ""}법령 전체 보기 · ${section.toc.count.toLocaleString("ko-KR")}개 조문`
          : heading;
        return <details key={index} className="law-detail-source" data-kind={section.kind}>
          <SourceToggleSummary label={label} openLabel={`${label} 접기`} />
          <LawTextBlock className="legal-analysis-raw" text={readerText(section.lines.join("\n"))} />
        </details>;
      })}
    </section>}
    <details className="law-detail-source research-source" open={expandSources}>
      <SourceToggleSummary label="출처 원문 전체 보기" openLabel="출처 원문 접기" />
      <p className="research-meta">법제처에서 받은 원문 그대로입니다. 인용 전에 시행 시점을 대조해 주세요.</p>
      <LawTextBlock className="legal-analysis-raw" text={readerText(data.text)} />
    </details>
    <p className="legal-analysis-note">조회 경로: {result.sources.map((source) => source.replace(" OPEN API", "")).join(" · ")}. {RESULT_NOTE}</p>
  </div>;
}
