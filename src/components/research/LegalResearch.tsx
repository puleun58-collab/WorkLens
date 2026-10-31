"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  AMENDMENT_SCENARIOS, DISPUTE_DOMAINS, EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_DOCUMENT_MAX_CHARS, LAW_RESEARCH_DOCUMENT_MIN_CHARS,
  LAW_RESEARCH_ERROR, LAW_RESEARCH_NAME_MAX_CHARS, LAW_RESEARCH_QUERY_MAX_CHARS, LAW_RESEARCH_TASKS, LAW_RESEARCH_USER_TASKS, isUserVisibleResearchTask, lawResearchOutcome, lawResearchRequestFor,
  type AmendmentScenario, type DisputeDomain, type LawResearchData, type LawResearchDraft, type LawResearchOutcome,
  type InterpretationFailure, type IssueEvidence, type LawCurrency, type LawResearchRequest, type LawResearchTask, type OrdinanceRegionResult, type ResearchInterpretation,
} from "@/lib/law-research";
import { groupLawSystemArticles, lawSystemTopSummary } from "@/lib/law-system-display";
import { askedArticles } from "@/lib/law-system-evidence";
import { isSupportingSection, mergeDuplicateAnnexSections, researchResult, type ResearchDecision, type ResearchSection } from "@/lib/law-research-parse";
import { articleHeadingText, dedupeArticleHeadingLine, dedupeArticleHeadings } from "@/lib/law-article-target";
import { lawDisplayText } from "@/lib/law-display";
import { orderByRelevance, type ResearchEnrichment } from "@/lib/research-relevance";
import { STATUS_TITLE, type ResearchStatus } from "@/lib/research-status";
import { researchConfirmationGap } from "@/lib/research-result-status";
import { taskEvidenceReferences, type TaskEvidenceArticle } from "@/lib/task-evidence";
import { lawSourceUrl, sameLawFamily } from "@/lib/research-scope";
import type { ProcedureRequirementStatus } from "@/lib/procedure-evidence";
import { LawTextBlock } from "./LawTextBlock";
import { articleDisplayKey, hasQuestionTermInTitle } from "./research-result-display";
import { ContractReviewResult, FileReviewExcluded } from "./ContractReviewResult";
import { SourceToggleSummary } from "./SourceToggleSummary";
import { ResearchResultSummary, ResearchSummaryNotice, ResearchSummaryNotices, STATUS_BADGE } from "./ResearchResultSummary";
import type { ReviewableFiles } from "./LawSearch";
import type { WorkspaceFile } from "@/client/protocol";
import { runInWorker } from "@/client/document-client";
import { reviewFileIdentityMatches, reviewIsStale } from "@/client/review-provenance";
import { reviewRequestFor, type ReviewFile } from "@/lib/law-review-source";
import { readReviewPreferences, resolveReviewPreferences, type ReviewPreferences } from "@/client/review-preferences";
import { ArrowDownRight, ChevronDown, Plus, Upload } from "lucide-react";
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
  /** Monotonic id of the execution that produced this entry; result-local UI state never outlives it. */
  run: number;
  /** 문서 검토 of a workspace file: its segments' sources and what part of it was reviewed. */
  file?: ReviewFile;
  /** The exact workspace entry used when starting this file review (not a later replacement). */
  workspaceFile?: WorkspaceFile;
}

/** 문서 검토 keeps one result per review target: the direct input, and each workspace file. */
type ResultKey = LawResearchTask | "document_review:text" | `document_review:file:${string}`;
const TEXT_RESULT_KEY: ResultKey = "document_review:text";
const fileResultKey = (fileId: string): ResultKey => `document_review:file:${fileId}`;
const keyBelongsTo = (key: ResultKey, task: LawResearchTask) => key === task || key.startsWith(`${task}:`);

const FILE_READ_ERROR = "작업 파일을 읽지 못했습니다. 파일을 다시 올린 뒤 실행하세요.";

const TASK_HELP: Record<LawResearchTask, { description: string; placeholder: string }> = {
  full_research: { description: "질문·상황과 관련된 법령·판례·결정례 조사", placeholder: "예: 회사에서 업무와 관련해 지속적으로 모욕을 당했는데 어떤 법적 기준을 살펴봐야 하나요?" },
  law_system: { description: "한 법령의 법률·시행령·시행규칙 관계 확인", placeholder: "예: 개인정보 보호법 제38조와 시행령의 관계" },
  action_basis: { description: "처분·허가의 근거 조문과 확인 가능한 불복 자료 검색", placeholder: "예: 식품위생법상 영업정지의 근거와 요건" },
  dispute_prep: { description: "분쟁 상황과 관련된 법령·판례·결정례 조사", placeholder: "예: 부당해고 구제 신청 관련 판례와 결정례" },
  amendment_track: { description: "법령 개정 이력과 두 시점의 조문 차이 조사", placeholder: "예: 근로기준법 제60조 개정 내용" },
  ordinance_compare: { description: "두 지역의 같은 주제 조례와 확인된 조문 원문 비교", placeholder: "예: 주차장 설치 기준" },
  procedure_detail: { description: "절차의 근거 조문과 제출 서식 확인", placeholder: "예: 행정심판 청구 절차와 제출서류" },
  document_review: { description: "입력한 문서의 조항별 쟁점과 확인된 근거 검토", placeholder: "계약서 또는 약관 등의 내용을 붙여 넣으세요" },
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
  const files = useMemo(() => workspace?.files ?? [], [workspace?.files]);
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
  const [task, setTask] = useState<LawResearchTask>(isUserVisibleResearchTask(initialTask) ? initialTask : "full_research");
  /** A hidden task arrived (e.g. a stored initial task): the menu cannot
   * offer it, so the selection falls back without converting the question
   * into another task's result. */
  const [hiddenTaskNotice, setHiddenTaskNotice] = useState(!isUserVisibleResearchTask(initialTask));
  const [draft, setDraft] = useState<LawResearchDraft>(EMPTY_RESEARCH_DRAFT);
  const [results, setResults] = useState<Partial<Record<ResultKey, TaskResult>>>({});
  const liveFiles = useRef(files);
  useLayoutEffect(() => { liveFiles.current = files; }, [files]);
  const requests = useRef(new Map<ResultKey, AbortController>());
  const runs = useRef(0);

  useEffect(() => {
    const pending = requests.current;
    return () => pending.forEach((controller) => controller.abort());
  }, []);

  /** Publishes into `key` only while `controller` still owns it: superseded or cancelled runs never land. */
  const run = useCallback(async (key: ResultKey, request: LawResearchRequest, file?: ReviewFile, workspaceFile?: WorkspaceFile, runPreferences = preferences, pendingController?: AbortController) => {
    if (pendingController?.signal.aborted) return;
    if (!pendingController) requests.current.get(key)?.abort();
    const controller = pendingController ?? new AbortController();
    requests.current.set(key, controller);
    const snapshot = { request, preferences: { ...runPreferences }, run: ++runs.current, ...(file ? { file } : {}), ...(workspaceFile ? { workspaceFile } : {}) };
    setResults((current) => ({ ...current, [key]: { ...snapshot, outcome: null, loading: true } }));
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
    if (controller.signal.aborted || requests.current.get(key) !== controller) return;
    requests.current.delete(key);
    setResults((current) => ({ ...current, [key]: { ...snapshot, outcome, loading: false } }));
  }, [preferences]);

  /**
   * Reviews one workspace file: the worker builds the bounded request from the parsed document
   * (nothing is uploaded again), and a file with no reviewable text is reported, not sent.
   */
  const runFile = useCallback(async (fileId: string, expectedFile?: WorkspaceFile, runPreferences = preferences) => {
    const task = "document_review";
    const key = fileResultKey(fileId);
    const workspaceFile = workspace?.files.find((entry) => entry.id === fileId);
    if (!workspaceFile || (expectedFile && !reviewFileIdentityMatches(liveFiles.current, expectedFile))) return;
    if (requests.current.has(key)) return;
    const controller = new AbortController();
    requests.current.set(key, controller);
    const runId = ++runs.current;
    const requestSnapshot: LawResearchRequest = { task, text: "" };
    setResults((current) => ({ ...current, [key]: { request: requestSnapshot, workspaceFile, preferences: { ...runPreferences }, outcome: null, loading: true, run: runId } }));
    let file: ReviewFile;
    try {
      file = await runInWorker({ kind: "review-source", fileId });
    } catch {
      if (controller.signal.aborted) return;
      requests.current.delete(key);
      setResults((current) => ({ ...current, [key]: { request: requestSnapshot, workspaceFile, preferences: { ...runPreferences }, outcome: { kind: "error", message: FILE_READ_ERROR }, loading: false, run: runId } }));
      return;
    }
    if (controller.signal.aborted) return;
    if (!reviewFileIdentityMatches(liveFiles.current, workspaceFile, file)) {
      requests.current.delete(key);
      setResults((current) => ({ ...current, [key]: { request: requestSnapshot, workspaceFile, file, preferences: { ...runPreferences }, outcome: { kind: "error", message: FILE_READ_ERROR }, loading: false, run: runId } }));
      return;
    }
    // Only the projected DTO is sent: text, positions and identity, never the selector's hints.
    const request: LawResearchRequest = reviewRequestFor(file.document);
    if (file.coverage.status === "excluded") {
      requests.current.delete(key);
      setResults((current) => ({ ...current, [key]: { request, outcome: null, loading: false, file, workspaceFile, run: runId } }));
      return;
    }
    await run(key, request, file, workspaceFile, runPreferences, controller);
  }, [run, workspace?.files, preferences]);

  /** Leaving a task cancels its in-flight chains; finished results stay for when the user comes back. */
  function changeTask(next: LawResearchTask) {
    if (!isUserVisibleResearchTask(next)) {
      setHiddenTaskNotice(true);
      next = "full_research";
    } else {
      setHiddenTaskNotice(false);
    }
    const pending = [...requests.current.keys()].filter((key) => keyBelongsTo(key, task));
    if (pending.length) {
      pending.forEach((key) => { requests.current.get(key)?.abort(); requests.current.delete(key); });
      setResults((current) => {
        const copy = { ...current };
        pending.forEach((key) => { delete copy[key]; });
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
    if (!isUserVisibleResearchTask(initialTask)) {
      setHiddenTaskNotice(true);
      setTask("full_research");
    } else {
      setHiddenTaskNotice(false);
      setTask(initialTask);
    }
    setPreferenceOverride({});
  }, [initialTask]);

  const update = <K extends keyof LawResearchDraft>(key: K, value: LawResearchDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const validRequest = lawResearchRequestFor(task, draft);
  // Keep the exact pasted input in the existing request snapshot, including whitespace.
  // Validation remains unchanged, and the API already trims text before reviewing it.
  const request = validRequest && task === "document_review" && "text" in validRequest
    ? { ...validRequest, text: draft.text } : validRequest;
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
  // The current input decides which stored result is shown; other targets' results are kept, not shown.
  const resultKey: ResultKey = !isDocument ? task : fromFile ? fileResultKey(fileId) : TEXT_RESULT_KEY;
  const stored = results[resultKey];
  const current = stored && (fromFile || !isDocument || !reviewIsStale(stored, { fromFile, fileId, request, files })) ? stored : undefined;
  const loading = current?.loading === true;
  // The reviewed workspace entry was replaced since: its locations are historical and it cannot be re-run.
  const sourceChanged = Boolean(current?.workspaceFile
    && !reviewFileIdentityMatches(files, current.workspaceFile, current.file));

  function retry() {
    if (!current || loading || sourceChanged) return;
    if (current.workspaceFile && !current.file) {
      void runFile(current.workspaceFile.id, current.workspaceFile, current.preferences);
    } else {
      void run(resultKey, current.request, current.file, current.workspaceFile, current.preferences);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || !canRun) return;
    if (fromFile) void runFile(fileId);
    else if (request) void run(resultKey, request);
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
  return <div className="legal-analysis legal-research">
    <div className={`research-workspace${isDocument ? " is-document" : ""}`}>
    <div className="research-workspace-main">
    <form className={`legal-analysis-form${isDocument ? " research-document-workarea" : ""}`} onSubmit={submit} aria-label={isDocument ? "문서 검토 입력" : "종합 리서치 입력"}>
      <div className="legal-analysis-fields legal-research-options">
        <Field><FieldLabel htmlFor="research-task">리서치 유형</FieldLabel>
          <Select items={LAW_RESEARCH_USER_TASKS} value={task} onValueChange={(value) => { if (value) changeTask(value as LawResearchTask); }}>
            <SelectTrigger id="research-task"><SelectValue /></SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>{LAW_RESEARCH_USER_TASKS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>
        {isDocument && settingsError && <p className="law-search-error" role="alert">{settingsError}</p>}
        {task === "dispute_prep" && <Field><FieldLabel htmlFor="research-domain">분야</FieldLabel>
          <Select items={DISPUTE_DOMAINS} value={draft.domain} onValueChange={(value) => update("domain", (value ?? "") as DisputeDomain | "")}>
            <SelectTrigger id="research-domain"><SelectValue /></SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>{DISPUTE_DOMAINS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>}
        {task === "amendment_track" && <Field><FieldLabel htmlFor="research-scenario">추적 방식</FieldLabel>
          <Select items={[{ value: "", label: "자동" }, ...AMENDMENT_SCENARIOS]} value={draft.scenario} onValueChange={(value) => update("scenario", (value ?? "") as AmendmentScenario | "")}>
            <SelectTrigger id="research-scenario"><SelectValue /></SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}><SelectItem value="">자동</SelectItem>{AMENDMENT_SCENARIOS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>}
      </div>
      <p className="legal-research-description">{TASK_HELP[task].description}</p>
      {hiddenTaskNotice && <p className="research-meta" role="status">절차·서식 유형은 현재 선택 목록에서 제외되어 있습니다. 다른 유형을 선택해 주세요.</p>}

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
          <div className="research-input-footer">
            <div className="research-input-submit">
              <p id="research-document-help" className="legal-analysis-help">
                <span className="legal-analysis-count">{draft.text.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_DOCUMENT_MAX_CHARS.toLocaleString("ko-KR")}자 · 최소 {LAW_RESEARCH_DOCUMENT_MIN_CHARS}자</span>
              </p>
              {runButton}
            </div>
          </div>
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
        <Input id="research-parent-law" type="text" value={draft.parentLaw} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder="요청에 법령이 명시된 경우만 입력 · 예: 주차장법" onChange={(event) => update("parentLaw", event.target.value)} />
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

      {!isDocument && <div className={`legal-analysis-actions${task === "ordinance_compare" ? " legal-research-action-row" : ""}`}>
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
    <span className="sr-only" role="status">{loading ? (isDocument ? "문서 검토 중…" : "리서치 중…") : ""}</span>
    </div>

    {current && !current.loading && <section key={current.run} className="legal-analysis-result" aria-label={isDocument ? "검토 결과" : "리서치 결과"}>
      {isDocument && sourceChanged && current.outcome?.kind !== "error" && <p className="research-meta" role="status" data-review-stale="true">
        원본 파일이 변경되거나 삭제되어 이전 검토 위치를 확인할 수 없습니다.
      </p>}
      {current.outcome?.kind === "error" ? isDocument ? <div className="contract-review">
          <ResearchResultSummary label="문서 검토" badge={{ tone: "error", label: "검토 오류" }} title="문서 검토를 완료하지 못했습니다">
            {current.file && <p className="research-meta research-summary-meta contract-review-file">검토 문서: {current.file.document.name}</p>}
            <ResearchSummaryNotices>
              <ResearchSummaryNotice tone="error" title="검토 오류"><p className="law-search-error">{current.outcome.message}</p></ResearchSummaryNotice>
            </ResearchSummaryNotices>
            <Button type="button" variant="link" className="law-search-link" disabled={sourceChanged} onClick={retry}>다시 시도</Button>
            {sourceChanged && <p className="research-meta" role="status">원본 파일이 삭제되었거나 변경되어 다시 시도할 수 없습니다. 파일을 선택하고 새로 실행하세요.</p>}
          </ResearchResultSummary>
        </div> : <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <Button type="button" variant="link" className="law-search-link" disabled={sourceChanged} onClick={retry}>다시 시도</Button>
          {sourceChanged && <p className="research-meta" role="status">원본 파일이 삭제되었거나 변경되어 다시 시도할 수 없습니다. 파일을 선택하고 새로 실행하세요.</p>}
        </div>
        : current.file && !current.outcome ? <FileReviewExcluded file={current.file} />
        : current.outcome?.kind === "missing" ? <div className={`legal-analysis-missing${isDocument ? " contract-review" : ""}`} role="status">
          <ResearchResultSummary label={isDocument ? "문서 검토" : LAW_RESEARCH_TASKS.find((item) => item.value === current.request.task)?.label}
            badge={STATUS_BADGE.none} status="none" title={STATUS_TITLE.none}
            caution="※ 조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다." cautionClassName="research-caution">
            {isDocument && current.file && <p className="research-meta research-summary-meta contract-review-file">검토 문서: {current.file.document.name}</p>}
            {current.request.task !== "document_review" && <p className="research-meta research-summary-meta research-query">입력한 질문: {current.request.query}</p>}
            {current.request.task === "full_research" && current.outcome.data.interpretation?.original === current.request.query
              && <ResearchUnderstanding interpretation={current.outcome.data.interpretation} />}
            {current.request.task === "full_research" && !current.outcome.data.interpretation
              && <p className="research-meta research-uninterpreted">{UNINTERPRETED_NOTE[current.outcome.data.interpretationFailure ?? "unavailable"]}</p>}
          </ResearchResultSummary>
        </div>
        : current.outcome?.kind === "found" ? current.outcome.data.review
          ? <ContractReviewResult review={current.outcome.data.review} file={current.file} expandSources={preferences.expandSources}
            onExpandSourcesChange={(expandSources) => setPreferenceOverride((current) => ({ ...current, expandSources }))} />
          : <ResearchResult data={current.outcome.data} request={current.request} expandSources={current.request.task === "full_research" && preferences.expandSources}
            onExpandSourcesChange={(expandSources) => setPreferenceOverride((current) => ({ ...current, expandSources }))} />
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
  const heading = dedupeArticleHeadingLine(lawDisplayText(section.heading?.replace(/\s*\[[^\]]*\]/gu, "")
    .replace(/^\s*(?:(?:STEP|단계)\s*\d+|(?:OPEN\s+)?API\s*(?:응답|오류|조회)?)\s*[:.)-]?\s*/iu, "").trim()));
  const dates = /^Time Travel\s*[—–-]\s*(.+?)\s*\((\d{8})\s*↔\s*(\d{8})\)$/u.exec(heading);
  if (!dates) return heading;
  const from = formatDate(dates[2]);
  const to = formatDate(dates[3]);
  return `두 시점의 조문 비교 · ${dates[1]}${from && to ? ` (${from} → ${to})` : ""}`;
}

/** Source excerpts remain legible; agent-facing diagnostics do not become reader-facing claims. */
/**
 * The MCP itself truncates a long article preview mid-article (a `③...`
 * cut). The server and the UI cut with a single `…`, so a trailing `...`
 * marks a received excerpt that is not the whole article: it must not read
 * as if the full text had been shown.
 */
/** Upstream excerpts end with "..." or "…" when cut; an unmarked cut is
 * still possible, so the task-evidence section also carries a general note. */
const mcpTruncated = (excerpt: string): boolean => /(?:\.\.\.|…)\s*$/u.test(excerpt.trim());

/** One annex table cell: text only (tags stripped, <br> kept as a line
 * break) with its original row/column spans, so a criteria table keeps
 * its grid instead of running numbers together. */
interface AnnexCell { text: string; header: boolean; rowSpan?: number; colSpan?: number }
type AnnexBlock = { kind: "text"; text: string } | { kind: "table"; rows: AnnexCell[][] };
const annexCellText = (html: string) => lawDisplayText(html
  .replace(/<\s*br\s*\/?\s*>/giu, "\n")
  .replace(/&nbsp;/giu, " ").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&amp;/giu, "&")
  .replace(/<[^>]*>/gu, "")).trim();
const annexSpan = (attrs: string, name: string) => {
  const value = Number(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "iu").exec(attrs)?.[1]);
  return value > 1 ? value : undefined;
};
/** Splits an annex original into text runs and parsed tables. A table
 * whose markup cannot be read as rows of cells stays text (its tags
 * stripped), so nothing is silently dropped. The stored text is untouched. */
function annexBlocks(text: string): AnnexBlock[] {
  const blocks: AnnexBlock[] = [];
  let rest = text;
  for (let match = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/iu.exec(rest); match; match = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/iu.exec(rest)) {
    const before = rest.slice(0, match.index);
    if (before.trim()) blocks.push({ kind: "text", text: lawDisplayText(before.replace(/<[^>]*>/gu, "")) });
    const rows = [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)].map((row) =>
      [...row[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]\s*>/giu)].map((cell) => ({
        text: annexCellText(cell[3]), header: cell[1].toLowerCase() === "th",
        rowSpan: annexSpan(cell[2], "rowspan"), colSpan: annexSpan(cell[2], "colspan"),
      }))).filter((row) => row.length > 0);
    blocks.push(rows.length ? { kind: "table", rows } : { kind: "text", text: annexCellText(match[1]) });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest.trim()) blocks.push({ kind: "text", text: lawDisplayText(rest.replace(/<[^>]*>/gu, "")) });
  return blocks;
}

function AnnexOriginal({ text }: { text: string }) {
  return <div className="research-annex-original">{annexBlocks(text).map((block, index) => block.kind === "text"
    ? <LawTextBlock key={index} className="legal-analysis-lines" text={block.text} />
    : <div key={index} className="research-table-scroll"><table className="research-annex-table"><tbody>
      {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
        const Cell = cell.header ? "th" : "td";
        return <Cell key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{cell.text}</Cell>;
      })}</tr>)}
    </tbody></table></div>)}</div>;
}

function readerText(text: string): string {
  return dedupeArticleHeadings(lawDisplayText(text.split(/\r?\n/u).filter((line) =>
    !/^\s*(?:(?:STEP\s*\d+|(?:OPEN\s+)?API\b)[\s:.)-]|\[(?:EXTERNAL_API_ERROR|REQUEST_TIMEOUT)\]|HTTP\s+\d{3}\b|검색\s*보정(?:\s*시도)?\s*[:：]|재시도(?:\s*제안)?\s*[:：]|힌트\s*[:：]|💡\s*다음\s*[:：]|사유\s*[:：]\s*\[(?:FAILED|NOT_FOUND)|⚠️\s*이 섹션은 조회 실패|특정\s*조문\s*조회\s*:\s*get_|.*법제처\s*API는\s*공백)/iu.test(line),
  ).join("\n")));
}

type ResearchGroup = "statutes" | "decisions" | "change" | "regional" | "forms" | "other";
const GROUP_LABELS: Record<Exclude<LawResearchTask, "document_review">, Partial<Record<ResearchGroup, string>>> = {
  full_research: { statutes: "관련 법령·조문", decisions: "관련 판례·결정례", other: "참고 자료" },
  law_system: { statutes: "법령·조문", other: "법률·시행령·시행규칙 관계", decisions: "참고 결정" },
  action_basis: { statutes: "처분·허가의 법령 근거", decisions: "관련 불복·해석 자료", other: "추가 근거" },
  dispute_prep: { statutes: "관련 법령", decisions: "판례·결정례·재결례", other: "쟁송 참고 자료" },
  amendment_track: { change: "시점별 개정 내용", statutes: "관련 조문", other: "개정 참고 자료" },
  ordinance_compare: { regional: "지역별 자치법규", statutes: "상위 법령·조문", other: "비교 참고 자료" },
  procedure_detail: { forms: "관련 법령 서식 목록", statutes: "절차의 법령 근거", other: "절차·비용 자료" },
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

/** Per-requirement outcome for 절차·서식, from the server's evidence verdict. */
const PROCEDURE_REQUIREMENT_LABEL: Record<ProcedureRequirementStatus, string> = {
  found: "근거 확인",
  viewed: "관련 자료 조회",
  none: "직접 관련 근거 미확인",
  failed: "자료 확인 실패",
};

/** Server per-kind evidence labels for law_system / action_basis / dispute_prep / amendment_track. */
const TASK_EVIDENCE_LABEL: Record<"found" | "viewed" | "none" | "failed", string> = {
  found: "근거 확인",
  viewed: "자료 조회",
  none: "미확인",
  failed: "조회 미완료",
};

/** Law-system tier outcome: delegation-link verdicts, apart from retrieval. */
const LAW_SYSTEM_TIER_LABEL: Record<"found" | "viewed" | "none" | "failed", string> = {
  found: "직접 연결 확인",
  viewed: "관련 조문 조회",
  none: "직접 연결 미확인",
  failed: "조회 미완료",
};
const LAW_TIER_LABEL: Record<"found" | "viewed" | "none" | "failed", string> = {
  found: "원문 확인",
  viewed: "관련 자료 조회",
  none: "원문 미확인",
  failed: "조회 미완료",
};

/** Per-provision relation labels for law-system aggregate items. */
const LAW_SYSTEM_RELATION_LABEL: Record<"direct" | "twoWay" | "other" | "unidentified" | "related", string> = {
  twoWay: "법률에서 위임한 사항 확인",
  direct: "질문한 조항 인용 확인",
  other: "다른 조항 참조",
  unidentified: "위임 대상 조항 확인 필요",
  related: "조회된 조항",
};

/** 입력한 질문 → 이렇게 이해했어요 → 살펴볼 쟁점: sibling blocks, each opened by the same rule; empty ones are not rendered.
 * With onIssueSelect, each top-list item is itself the jump button to its
 * detail section (replacing the separate 쟁점 바로가기 nav); without it the
 * list stays plain text. The button keeps the old nav's aria-controls and
 * showIssue behavior, so focus/scroll handling is unchanged. */
function ResearchUnderstanding({ interpretation, evidence = [], hasReferences, onIssueSelect }: { interpretation: ResearchInterpretation; evidence?: readonly IssueEvidence[]; hasReferences?: (entry: IssueEvidence) => boolean; onIssueSelect?: (index: number) => void }) {
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
        const occurrence = issues.slice(0, index).filter((label) => label === issue).length;
        const targetIndex = evidence.map((entry, evidenceIndex) => ({ entry, evidenceIndex }))
          .filter(({ entry }) => entry.label?.trim() === issue)[occurrence]?.evidenceIndex;
        const entry = targetIndex === undefined ? undefined : evidence[targetIndex];
        const missingReference = entry?.status === "found" && hasReferences && !hasReferences(entry);
        const label = <span className="research-issue-label"><span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>{issue}</span>;
        return <li key={index}>
          {onIssueSelect && targetIndex !== undefined
            ? <button type="button" className="research-issue-jump" aria-controls={`research-issue-${targetIndex + 1}`} onClick={() => onIssueSelect(targetIndex)}>{label}</button>
            : label}
          {entry && <span className="research-issue-status" data-status={entry.status}>{missingReference ? "표시 근거 없음" : ISSUE_STATUS_LABEL[entry.status]}</span>}
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

/** Additional sources keep their rows; repeated excerpts link to their existing detail. */
function SupplementView({ supplement, hasArticles, shownArticleKeys, sourceTargets, onSourceSelect }: {
  supplement: NonNullable<ResearchEnrichment["supplement"]>; hasArticles: boolean;
  shownArticleKeys?: ReadonlySet<string>;
  sourceTargets: ReadonlyMap<string, string>; onSourceSelect: (id: string) => void;
}) {
  if (!supplement.articles.length) {
    if (hasArticles || supplement.status === "not_searched") return null;
    return <div className="legal-analysis-section" data-kind="supplement" data-status={supplement.status}>
      <p className="research-meta">{supplement.status === "failed" ? "관련 조문 추가 조회 실패" : "관련 법령을 충분히 확인하지 못했습니다"}</p>
    </div>;
  }
  // Articles the task-evidence toggle already shows are not listed again;
  // the count keeps the audit trail, and the toggle keeps the excerpt.
  const isShown = (article: (typeof supplement.articles)[number]) => shownArticleKeys?.has(`${article.law}\u0000${article.jo}`) ?? false;
  const titleMatches = supplement.articles.filter((article) => hasQuestionTermInTitle(article) && !isShown(article));
  const otherArticles = supplement.articles.filter((article) => !hasQuestionTermInTitle(article) && !isShown(article));
  const excludedCount = supplement.articles.length - titleMatches.length - otherArticles.length;
  return <>{[titleMatches, otherArticles].map((articles, groupIndex) => articles.length > 0 && <div key={groupIndex}
    className="legal-analysis-section research-supplement" data-kind="supplement" data-status={supplement.status}>
    <h3>{groupIndex === 0 ? "제목에 질문 용어가 포함된 조문" : "추가로 조회한 조문"} <span className="research-meta">{articles.length}건</span></h3>
    <p className="research-meta">{groupIndex === 0 ? "조문 제목에 질문 용어가 포함된 자료를 추가로 조회했습니다." : "인용·명시 조문 등 추가 조회로 확보한 자료입니다. 개별 조회 경로는 구분되지 않을 수 있습니다."}</p>
    <p className="research-meta">직접 근거 채택에는 별도 관련성 검증이 필요합니다. 채택 여부는 쟁점별 결과와 대조하세요.</p>
    <ul className="research-hits">{articles.map((article, index) => {
      const effective = formatDate(article.effectiveDate);
      const target = sourceTargets.get(articleDisplayKey({ ...article, effective: article.effectiveDate }));
      return <li key={`${article.law}-${article.jo}-${index}`}>
        <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
        {target ? <Button type="button" variant="link" size="xs" className="research-source-jump" aria-controls={target}
          onClick={() => onSourceSelect(target)}>상세 근거에서 원문 보기</Button>
          : <details className="law-detail-source research-more">
            <SourceToggleSummary label="조문 발췌 보기" openLabel="조문 발췌 접기" />
            <LawTextBlock className="legal-analysis-lines" text={article.excerpt} />
            {mcpTruncated(article.excerpt) && <p className="research-meta">중략된 발췌입니다. 조문 전문은 법령 검색에서 확인하세요.</p>}
          </details>}
        {effective && <span className="research-meta">출처 시행일 {effective}</span>}
        {(() => { const url = lawSourceUrl(article.law, article.jo);
          return url ? <span className="research-meta"><a href={url} target="_blank" rel="noreferrer">법제처 원문 보기</a></span> : null; })()}
      </li>;
    })}</ul>
  </div>)}
  {excludedCount > 0 && <p className="research-meta">위 근거 영역에서 이미 확인한 조문 {excludedCount}건은 별도로 표시하지 않았습니다.</p>}</>;
}

/** Shown when the question could not be split into issues this time; the reason is named, since a busy AI is not a missing law. */
const UNINTERPRETED_NOTE: Record<InterpretationFailure, string> = {
  "rate-limited": "AI 사용 한도에 도달해 질문을 쟁점별로 나누지 못했습니다. 입력한 문장과 핵심어로 검색했으며, 잠시 후 다시 실행하면 쟁점별로 확인할 수 있습니다.",
  timeout: "AI 응답 시간이 초과되어 질문을 쟁점별로 나누지 못했습니다. 입력한 문장과 핵심어로 검색했으며, 잠시 후 다시 실행하면 쟁점별로 확인할 수 있습니다.",
  unavailable: "질문을 쟁점별로 나누지 못해 입력한 문장과 핵심어로 검색했습니다. 잠시 후 다시 실행하면 쟁점별로 확인할 수 있습니다.",
};

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
  timeout: "조회 미완료",
};

/** Top notice only for sections that failed or timed out; an empty search is a normal result. */
function partialNotice(sections: readonly ResearchSection[]): string | null {
  const failed = sections.some((section) => section.status === "failed");
  const timeout = sections.some((section) => section.status === "timeout");
  if (failed && timeout) return "일부 자료를 확인하지 못해 현재 조회된 결과만 표시합니다";
  if (failed) return "일부 자료를 불러오지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다";
  if (timeout) return "일부 자료 조회가 완료되지 않아 확인된 결과만 표시합니다";
  return null;
}

/**
 * The comparison table and the top counts must use the same final evidence
 * set. The table text is parsed without the law filter and dedup the
 * assessor applies, so followup articles can be missing from it. Append
 * them (marked) instead of letting the table undercount. A table row whose
 * header is too broken to parse stays as-is, so in that edge case the table
 * can still exceed the top count — reported, not silently fixed.
 */
function parseHierarchyRow(content: string): { law: string; jo: string } | null {
  const match = /^(.*?)\s+(제\d+조(?:의\d+)?)\s*(?:\(|$)/u.exec(content.trim());
  return match ? { law: match[1].trim(), jo: match[2] } : null;
}
export function appendMissingLawSystemArticles(
  hierarchy: Array<{ level: string; content: string }>,
  lawSystem: NonNullable<LawResearchData["lawSystem"]>,
): Array<{ level: string; content: string; appended?: boolean }> {
  const rows: Array<{ level: string; content: string; appended?: boolean }> = [...hierarchy];
  for (const item of lawSystem.items) {
    const level = item.label === "시행령" ? "시행령" : item.label === "시행규칙" ? "시행규칙" : null;
    if (!level) continue;
    for (const article of item.articles ?? []) {
      const shown = rows.some((row) => {
        if (row.level !== level) return false;
        const parsed = parseHierarchyRow(row.content);
        return parsed !== null && parsed.jo === article.jo && (!parsed.law || sameLawFamily(parsed.law, article.law));
      });
      if (!shown) rows.push({ level, content: `${article.law} ${article.jo}${article.title ? ` (${article.title})` : ""}`, appended: true });
    }
  }
  return rows;
}

function ResearchSectionView({ section, task, relevance, retried, lawSystem, articleTarget, sourceTargets, onSourceSelect }: {
  section: ResearchSection; task: LawResearchData["task"]; relevance?: ResearchEnrichment["precedents"];
  retried?: ResearchEnrichment["interpretations"]; lawSystem?: LawResearchData["lawSystem"];
  articleTarget?: (index: number) => string;
  sourceTargets?: ReadonlyMap<string, string>; onSourceSelect?: (id: string) => void;
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
      <p className="research-meta">질문의 핵심어로 다시 찾은 자료입니다. 사건과의 관련성은 원문으로 확인해 주세요</p>
      <DecisionList entries={found.entries} />
    </div>;
  }
  if (section.kind === "law_articles" && section.articles) {
    const articles = section.articles;
    const items = (from: number, to: number) => <ul className="research-hits">{articles.slice(from, to).map((article, index) => {
      const excerpt = readerText(article.excerpt);
      const effective = formatDate(article.effective);
      const canonicalTarget = sourceTargets?.get(articleDisplayKey(article));
      const repeated = canonicalTarget && canonicalTarget !== articleTarget?.(from + index);
      return <li key={`${article.law}-${article.jo}-${from + index}`} id={articleTarget?.(from + index)} tabIndex={-1} className="research-source-target">
        <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
        {repeated && onSourceSelect ? <Button type="button" variant="link" size="xs" className="research-source-jump"
          aria-controls={canonicalTarget} onClick={() => onSourceSelect(canonicalTarget)}>공통 근거 원문 보기</Button>
          : <>
            {excerpt && <LawTextBlock className="legal-analysis-lines" text={excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt} />}
            {mcpTruncated(excerpt) && <p className="research-meta">중략된 발췌입니다. 조문 전문은 법령 검색에서 확인하세요.</p>}
            {excerpt.length > 600 && <details className="law-detail-source research-more"><SourceToggleSummary label="조문 발췌 전체 보기" openLabel="조문 발췌 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>}
          </>}
        {(effective || article.ministry) && <span className="research-meta">{[effective && `출처 시행일 ${effective}`, article.ministry].filter(Boolean).join(" · ")}</span>}
      </li>;
    })}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>관련 조문 <span className="research-meta">{articles.length}건</span></h3>
      <p className="research-meta">조문 발췌입니다. 실제 적용 여부는 사실관계와 법령 원문으로 확인해 주세요</p>
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
      {rated && <p className="research-meta">판시사항을 기준으로 관련성이 높은 판례부터 표시</p>}
      {shown.length > 0
        ? <DecisionList entries={shown.slice(0, DECISION_PREVIEW)} />
        : <p className="research-meta research-empty">관련성이 높은 판례를 충분히 확인하지 못했습니다</p>}
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
    // The full list stays folded below: the unconfirmed list must not read as
    // the confirmed filing set (the confirmed set is the 절차 02 block above).
    const preview = task === "procedure_detail" ? 0 : ANNEX_PREVIEW;
    const list = (items: typeof entries) => <ul className="research-hits">{items.map((item, index) => <li key={`${item.title}-${index}`}>
      <strong>{item.formLabel ? `${item.formLabel} ` : ""}{item.title}</strong>{item.law && <span className="research-meta">{item.law}</span>}
    </li>)}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>{heading} <span className="research-meta">{total !== undefined && total > entries.length ? `전체 ${total.toLocaleString("ko-KR")}건 중 ${entries.length}건` : `${entries.length}건`}</span></h3>
      {list(entries.slice(0, preview))}
      {entries.length > preview && <details className="law-detail-source research-more">
        <SourceToggleSummary label={preview === 0 ? `목록 펼쳐보기 · ${entries.length}건` : `목록 펼쳐보기 · ${entries.length - preview}건 더`} openLabel="목록 접기" />
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
  const baseHierarchy = (task === "law_system" || Boolean(lawSystem)) && /3단 비교|법령 체계/u.test(heading) ? lines.flatMap((line) => {
    const match = /^\s*\[(법률|시행령|시행규칙)\]\s*(.+)$/u.exec(line);
    return match ? [{ level: match[1], content: match[2] }] : [];
  }) : [];
  // Identical response rows collapse to one tier row; the full original
  // lines stay in the "출처 내용 전체 보기" toggle below.
  const dedupedBaseHierarchy = baseHierarchy.filter((row, index) => baseHierarchy.findIndex((other) => other.level === row.level && other.content.trim() === row.content.trim()) === index);
  const collapsedHierarchyCount = baseHierarchy.length - dedupedBaseHierarchy.length;
  const hierarchy: Array<{ level: string; content: string; appended?: boolean }> = lawSystem && dedupedBaseHierarchy.length > 0 ? appendMissingLawSystemArticles(dedupedBaseHierarchy, lawSystem) : dedupedBaseHierarchy;
  const appendedHierarchyCount = hierarchy.length - dedupedBaseHierarchy.length;
  return <div className={className} data-kind={section.kind}>
    {heading && <h3>{heading}</h3>}
    {hierarchy.length > 0 ? <><dl className="research-hierarchy">{hierarchy.map((item, index) => <div key={index}><dt>{item.level}</dt><dd>{item.content}{item.appended && <span className="research-meta"> 추가 조회</span>}</dd></div>)}</dl>
      {collapsedHierarchyCount > 0 && <p className="research-meta">중복된 응답 행 {collapsedHierarchyCount}건을 하나로 합쳤습니다.</p>}
      {appendedHierarchyCount > 0 && <p className="research-meta">최종 검증 근거 중 응답 목록에 없던 조문 {appendedHierarchyCount}건을 보완했습니다.</p>}</>
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

export function ResearchResult({ data, request, expandSources = false, onExpandSourcesChange }: { data: LawResearchData; request: LawResearchRequest; expandSources?: boolean; onExpandSourcesChange: (expanded: boolean) => void }) {
  const resultRef = useRef<HTMLDivElement>(null);
  const activeIssue = useRef<HTMLElement | null>(null);
  const focusTimer = useRef<number | undefined>(undefined);
  // Synced from the details' own toggle events; a new result starts from the applied preference.
  const [referencesState, setReferencesState] = useState<{ data: LawResearchData; open: boolean } | null>(null);
  const allReferencesOpen = referencesState?.data === data ? referencesState.open : expandSources;
  const references = useCallback(() => resultRef.current?.querySelectorAll<HTMLDetailsElement>(".research-issue-refs"), []);
  const syncReferences = useCallback(() => {
    const details = references();
    setReferencesState({ data, open: !!details && details.length > 0 && [...details].every((detail) => detail.open) });
  }, [references, data]);
  const setReferencesOpen = useCallback((expanded: boolean) => {
    references()?.forEach((detail) => { detail.open = expanded; });
  }, [references]);
  useLayoutEffect(() => { setReferencesOpen(expandSources); }, [expandSources, data, setReferencesOpen]);
  useEffect(() => () => {
    window.clearTimeout(focusTimer.current);
    activeIssue.current?.classList.remove("is-focused", "is-focus-fresh", "is-focus-leaving");
  }, [data]);
  function showIssue(index: number) { showSource(`research-issue-${index + 1}`); }
  function showSource(id: string) {
    const target = resultRef.current?.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    for (let parent = target.parentElement; parent && parent !== resultRef.current; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    if (!target.classList.contains("research-issue-evidence")) {
      target.querySelectorAll("details").forEach((detail) => { detail.open = true; });
    }
    window.clearTimeout(focusTimer.current);
    activeIssue.current?.classList.remove("is-focused", "is-focus-fresh", "is-focus-leaving");
    target.classList.remove("is-focused", "is-focus-fresh", "is-focus-leaving");
    void target.offsetWidth;
    target.classList.add("is-focused", "is-focus-fresh");
    activeIssue.current = target;
    (target.querySelector<HTMLElement>("h3") ?? target).focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "instant", block: "start" });
    focusTimer.current = window.setTimeout(() => {
      target.classList.remove("is-focus-fresh");
      focusTimer.current = window.setTimeout(() => {
        target.classList.add("is-focus-leaving");
        focusTimer.current = window.setTimeout(() => {
          target.classList.remove("is-focused", "is-focus-leaving");
          activeIssue.current = null;
        }, 350);
      }, 1800);
    }, 800);
  }
  const result = researchResult(data.text);
  const full = data.task === "full_research";
  // 절차·서식 only: the server's per-requirement verdict. Without it (an older
  // or mocked response) the previous candidate-based rule below still applies.
  const procedure = data.task === "procedure_detail" ? data.procedure : undefined;
  const issueEvidence = full ? data.evidence?.issues ?? [] : [];
  // The shared chain supplement cannot be attributed to one issue, so its
  // incompleteness demotes only the overall status (matched → partial) through
  // the existing notice — never a per-issue label, and no result is dropped.
  const supplementIncomplete = full && (data.enrichment?.supplement?.partialFailure === true
    || data.enrichment?.supplement?.status === "failed");
  // (The result notice and the followup notice are computed below; they are
  // independent signals and neither suppresses the other.)
  const interpretation = full && data.interpretation?.original === (request.task === "document_review" ? "" : request.query) ? data.interpretation : undefined;
  const followupIncomplete = Boolean(data.followup && (data.followup.failed > 0 || data.followup.missing > 0 || data.followup.limited));
  const sectionNotice = partialNotice(result.sections);
  const searchNotice = full && data.evidence?.searchFailed ? "종합 검색 결과를 불러오지 못해 쟁점별로 확인한 자료만 표시합니다" : null;
  const genericLookupNotice = supplementIncomplete || issueEvidence.some((issue) => issue.status === "failed" || issue.status === "timeout" || issue.lookupPartial)
    ? "일부 쟁점의 자료를 확인하지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다" : null;
  // No suppression: a generic issue/supplement failure and a followup gap
  // may share one underlying failure or be independent, and the response
  // carries no cause identifier to prove sameness. Distinct titles keep
  // them distinguishable instead of hiding one.
  const notice = sectionNotice ?? searchNotice ?? genericLookupNotice;
  const otherFailureSignal = Boolean(sectionNotice ?? searchNotice ?? genericLookupNotice);
  // Annex original notice: per-entry verified counts, not the coarse
  // requirement stage (one verified entry used to hide every missing one).
  // A gap also exists when the list itself is cut, even if every listed
  // original is held. Responses without the counts fall back to the stage.
  const formsAnnex = (procedure?.requirements ?? []).filter((requirement) => requirement.kind === "forms" && requirement.annexCount > 0);
  const annexOriginalGap = formsAnnex.some((requirement) => requirement.annexVerifiedCount === undefined
    ? (requirement.annexOriginStage ?? procedure?.annexOriginStage ?? "list-only") === "list-only"
    : requirement.annexVerifiedCount < requirement.annexCount
      || (requirement.annexTotal !== undefined && requirement.annexCount < requirement.annexTotal));
  const annexDirectGap = formsAnnex.some((requirement) => requirement.directFormOriginalMissing);
  const annexFirst = formsAnnex[0];
  const annexListComplete = formsAnnex.length > 0 && formsAnnex.every((requirement) => requirement.annexTotal !== undefined && requirement.annexCount >= requirement.annexTotal);
  const annexVerifiedTotal = formsAnnex.reduce((sum, requirement) => sum + (requirement.annexVerifiedCount ?? 0), 0);
  const annexMissingPart = annexVerifiedTotal > 0 ? " 일부" : "";
  const annexNoticeText = !annexFirst ? null
    : annexListComplete
      ? `목록은 전부 조회됐으나 서식 원문${annexMissingPart}를 확인하지 못했습니다.`
      : annexFirst.annexTotal === undefined
        ? `서식 원문${annexMissingPart}를 확인하지 못했습니다.`
        : `서식 원문${annexMissingPart}를 확인하지 못했습니다. 현재 전체 ${annexFirst.annexTotal.toLocaleString("ko-KR")}건 중 ${annexFirst.annexCount}건의 목록만 조회됐습니다.`;
  const primary = result.sections.filter((section) => !isSupportingSection(section)
    && !/^\s*(?:STEP\s*\d+|(?:OPEN\s+)?API\b)/iu.test(section.heading ?? "")
    && (section.heading || readerText(section.lines.join("\n")))
    && (!full || groupOf(section, data.task) !== "other" || section.status !== "available"
      || (Boolean(data.lawSystem) && /3단 비교|법령 체계/u.test(section.heading ?? ""))));
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
  const hasIssueReferences = issueEvidence.length
    ? issueEvidence.some((issue) => selectedArticles.some((article) => issue.articles.some((reference) => reference.law === article.law && reference.jo === article.jo))
      || issue.precedents.some((id) => caseOf.has(id)))
    : selectedArticles.length + selectedCases.length > 0;
  const evidenceStatus = selectedArticles.length + selectedCases.length ? data.evidence?.status : "unverified";
  const unavailableCount = result.sections.filter((section) => section.unavailable).length;
  const visibleSelectedCaseIds = new Set(caseOf.keys());
  const candidatePrimary: ResearchSection[] = full ? primary.flatMap((section) => {
    if (section.articles) {
      const articles = section.articles.filter((article) => !selectedArticles.some((selected) => articleDisplayKey(selected) === articleDisplayKey(article)));
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
  // Server per-kind evidence for the four tasks that used to fall back to a
  // blanket weak result. When the server sent one, it is shown as-is (the
  // server already caps matched → partial on partial failures); responses
  // without it — older or mocked answers — keep the previous fallback, and
  // full_research / ordinance_compare / procedure_detail keep their own
  // verdicts untouched (procedure_detail keeps its merged PR #326 verdict).
  // A full_research answer can also carry a law-system followup verdict:
  // it is shown as its own assessed block, never merged into the issue
  // verdict, so the delegation assessment is visible instead of computed
  // and discarded.
  const taskEvidence = data.task === "law_system" || (full && data.lawSystem) ? data.lawSystem
    : data.task === "action_basis" ? data.actionBasis
    : data.task === "dispute_prep" ? data.dispute
    : data.task === "amendment_track" ? data.amendment : undefined;
  const isLawSystem = data.task === "law_system" || (full && Boolean(data.lawSystem));
  // Verified annex originals only: a list entry is never shown here, and a
  // merely identified (truncated) original is not presented as verified.
  // Identified and unrecovered annexes get their own blocks below, so a
  // missing table is never hidden behind the "확인한" heading.
  const verifiedAnnexes = (data.annexes ?? []).filter((annex) => annex.status === "verified");
  const identifiedAnnexes = (data.annexes ?? []).filter((annex) => annex.status === "identified");
  const unrecoveredAnnexes = (data.annexes ?? []).filter((annex) => annex.status === "failed" || annex.status === "not-found");
  // One status vocabulary for every task, decided by what was actually adopted, never by hit counts.
  const status: ResearchStatus = full
    ? evidenceStatus === "matched" ? notice ? "partial" : "matched" : evidenceStatus === "partial" ? "partial" : hasCandidates ? "weak" : otherFailureSignal || data.followup?.status === "failed" ? "failed" : "none"
    : procedure ? procedure.overall
    : comparison
      ? bothSides.length ? comparedRegions.length === 2 ? "matched" : "partial"
        : comparedRegions.some((region) => region.articles.length) ? "partial" : comparedRegions.length ? "weak" : comparison.regions.some((region) => region.status === "failed") ? "failed" : "none"
      : taskEvidence ? taskEvidence.status
      : !available ? unavailableCount ? "failed" : "none" : notice || unavailableCount ? "partial" : data.task === "document_review" ? "matched" : "weak";

  const confirmationGap = researchConfirmationGap(data, status);
  const taskItems = taskEvidence?.items.map((item) => ({ ...item, references: taskEvidenceReferences(item) })) ?? [];
  /** Asked articles for the law-system core result (structure A). */
  const askedLawArticles = isLawSystem && request.task !== "document_review" ? askedArticles(request.query, undefined) : [];
  /** The asked parent-law provision itself, when its body was retrieved:
   * shown once under the 법률 tier instead of in the supplement list. */
  const askedLawRefs = data.task === "law_system" ? [...new Map((data.enrichment?.supplement?.articles ?? [])
    .filter((article) => askedLawArticles.includes(article.jo) && !/시행령|시행규칙/u.test(article.law) && (article.excerpt ?? "").trim())
    .map((article) => [`${article.law}\u0000${article.jo}`, { law: article.law, jo: article.jo, title: article.title, excerpt: article.excerpt }] as const)).values()] : [];
  // Articles the task-evidence toggle already shows (law + article): the
  // supplement lists only the rest, so one article is not shown twice.
  const taskArticleKeys = new Set([...taskItems.flatMap((item) => item.references.map((article) => `${article.law}\u0000${article.jo}`)),
    ...askedLawRefs.map((article) => `${article.law}\u0000${article.jo}`)]);
  const hasTaskDetail = (item: (typeof taskItems)[number]) => item.references.length > 0
    || (data.task === "action_basis" && (item.basisRefs !== undefined || item.requirementRefs !== undefined));
  // Only an actual complete verdict proves that these remaining reads are reference-only.
  const followupSeverity = !followupIncomplete ? null
    : status === "matched" && !confirmationGap && !otherFailureSignal ? "info"
    : data.followup?.status === "failed" ? "error" : "warning";
  const followupNoticeText = followupSeverity === "info" ? data.followup?.failed
    ? "핵심 근거는 확인했으나 일부 참고 자료 조회가 실패하거나 완료되지 않았습니다."
    : "핵심 근거는 확인했으나 일부 참고 자료는 확보하지 못했습니다."
    : followupSeverity === "error" ? "추가 자료 조회를 완료하지 못했습니다. 이미 확보한 근거는 아래에 유지합니다. 조회 실패는 근거가 없다는 뜻이 아닙니다."
    : followupSeverity === "warning" ? "일부 추가 조회가 완료되지 않았습니다. 확인된 항목과 미확인 항목을 대조해 주세요." : null;
  const followupNoticeTitle = followupSeverity === "info" ? "일부 참고 자료 미확보"
    : followupSeverity === "error" ? "추가 자료 조회 미완료" : "추가 자료 확인 필요";
  // One missing-evidence notice: when a required kind is unconfirmed and
  // follow-up reads were also incomplete, both reasons go in that one notice
  // (each named only when it actually occurred) instead of two boxes.
  const followupInGap = Boolean(confirmationGap && (followupSeverity === "warning" || followupSeverity === "error"));
  const gapText = confirmationGap && (followupInGap
    ? `${confirmationGap.text} 일부 자료 조회도 완료되지 않았습니다.${followupSeverity === "error" ? " 조회 실패는 근거가 없다는 뜻이 아닙니다." : ""}`
    : confirmationGap.text);

  // These targets affect rendering only; adopted evidence and all counts above stay intact.
  const sourceTargets = new Map<string, string>();
  const selectedTargets = new Map<string, string>();
  selectedArticles.forEach((article, index) => {
    const issueIndex = issueEvidence.length ? issueEvidence.findIndex((issue) => issue.articles.some((ref) => ref.law === article.law && ref.jo === article.jo)) : 0;
    if (issueIndex < 0) return;
    const id = `research-article-${index + 1}`;
    const key = articleDisplayKey(article);
    sourceTargets.set(key, id);
    selectedTargets.set(key, id);
  });
  const primaryTarget = (sectionIndex: number, articleIndex: number) => `research-source-${sectionIndex}-${articleIndex}`;
  candidatePrimary.forEach((section, sectionIndex) => {
    if (section.status !== "available") return;
    section.articles?.forEach((article, articleIndex) => {
      const key = articleDisplayKey(article);
      if (!sourceTargets.has(key)) sourceTargets.set(key, primaryTarget(sectionIndex, articleIndex));
    });
  });
  // Step/form refs carry law + article only (no excerpt), so they cannot
  // match an articleDisplayKey; resolve them by law + article to the same
  // detailed-evidence anchor the group sections render. A ref with no such
  // anchor gets no jump button (never a button to a missing target).
  const lawJoTargets = new Map<string, string>();
  for (const [key, id] of sourceTargets) {
    try {
      const parsed = JSON.parse(key) as [string, string, string, string];
      const lawJo = `${parsed[0]}\u0000${parsed[1]}`;
      if (!lawJoTargets.has(lawJo)) lawJoTargets.set(lawJo, id);
    } catch { /* a non-JSON key is never a step/form target */ }
  }
  const supplement = data.enrichment?.supplement;
  const showSupplement = supplement && (supplement.articles.length > 0 || (!articleCount && supplement.status !== "not_searched"));
  const sourceJump = (id: string, label = "근거 보기") => <Button type="button" variant="link" size="xs"
    className="research-source-jump" aria-controls={id} onClick={() => showSource(id)}>{label}</Button>;
  /** One provision row for the task-evidence toggle; the toggle's list is
   * the single home for provisions (detail text never repeats it). */
  const taskReferenceItem = (article: (typeof taskItems)[number]["references"][number], key: string | number) => (
    <li key={key}>
      <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
      <span className="research-meta">{"relation" in article ? LAW_SYSTEM_RELATION_LABEL[article.relation] : "조회 원문에서 이 항목의 근거 문언 확인"}{"expression" in article && article.expression ? ` · ${article.expression}` : ""}</span>
      {"note" in article && article.note ? <span className="research-meta">{article.note}</span> : null}
      {"excerpt" in article && <><LawTextBlock className="legal-analysis-lines" text={article.excerpt} />
        {mcpTruncated(article.excerpt) && <p className="research-meta">중략된 발췌입니다. 조문 전문은 법령 검색에서 확인하세요.</p>}
        <a className="research-meta" href={lawSourceUrl(article.law, article.jo)} target="_blank" rel="noreferrer">법제처 원문 보기</a></>}
    </li>
  );
  return <div ref={resultRef} className="legal-analysis-output" data-task={data.task}>
    <ResearchResultSummary label={LAW_RESEARCH_TASKS.find((item) => item.value === data.task)?.label} badge={confirmationGap ? { tone: "warning", label: confirmationGap.badge } : STATUS_BADGE[status]} status={status} title={confirmationGap?.title ?? STATUS_TITLE[status]}
      caution={status === "matched" || status === "partial" || status === "viewed" || (status === "weak" && !full && !comparison)
        ? `※ ${full ? "확인한 근거는" : "조회한 자료는"} 관련 쟁점을 검토하기 위한 자료이며, 구체적인 사건의 법적 결론을 의미하지 않습니다.`
        : status === "none" ? "※ 조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다." : undefined}
      cautionClassName="research-caution">
      {request.task !== "document_review" && <p className="research-meta research-summary-meta research-query">입력한 질문: {request.query}</p>}
      {interpretation && <ResearchUnderstanding interpretation={interpretation} evidence={issueEvidence}
        hasReferences={(entry) => selectedArticles.some((article) => entry.articles.some((ref) => ref.law === article.law && ref.jo === article.jo)) || entry.precedents.some((id) => caseOf.has(id))}
        onIssueSelect={full && issueEvidence.length > 1 ? showIssue : undefined} />}
      {full && !data.interpretation && <p className="research-meta research-uninterpreted">{UNINTERPRETED_NOTE[data.interpretationFailure ?? "unavailable"]}</p>}
      {procedure && procedure.steps && procedure.steps.length > 0 && <div className="research-original research-issues is-assessed" data-procedure-steps="true">
        <span>01 {procedure.requirements.find((requirement) => requirement.kind === "procedure")?.label ?? "청구 절차"}</span>
        {(() => { const requirement = procedure.requirements.find((item) => item.kind === "procedure");
          return requirement ? <span className="research-issue-status" data-status={requirement.status}>{PROCEDURE_REQUIREMENT_LABEL[requirement.status]}</span> : null; })()}
        <ul>{procedure.steps.map((step, index) => <li key={step.phase}>
          <span className="research-issue-label"><span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>{step.label}</span>
          {step.missing
            ? <span className="research-issue-status" data-status="none">확인 필요</span>
            : <span className="research-issue-status" data-status="found">근거 확인</span>}
          {step.articles.map((article, articleIndex) => <Fragment key={`${article.law}-${article.jo}-${articleIndex}`}>
            <span className="research-meta">
              {article.law} {article.jo}{article.title ? ` (${article.title})` : ""}
              {(() => { const url = lawSourceUrl(article.law, article.jo); return url ? <span> · <a href={url} target="_blank" rel="noreferrer">법제처 원문 보기</a></span> : null; })()}
            </span>
            {article.excerpt && <span className="research-meta">{article.excerpt}</span>}
            {(() => { const target = lawJoTargets.get(`${article.law}\u0000${article.jo}`);
              return target ? sourceJump(target, "상세 근거에서 원문 보기") : null; })()}
          </Fragment>)}
          {step.missing && <span className="research-meta">이 단계의 근거 조문을 확인하지 못했습니다.</span>}
        </li>)}</ul>
        <p className="research-meta">단서·예외·적용 제외는 아래 근거 원문에서 확인하세요.</p>
      </div>}
      {procedure && (() => {
        const formsReq = procedure.requirements.find((requirement) => requirement.kind === "forms");
        const forms = formsReq?.classifiedForms;
        if (!formsReq || !forms || forms.length === 0) return null;
        const required = forms.filter((form) => form.duty === "required");
        const conditional = forms.filter((form) => form.duty === "conditional");
        const formRow = (form: (typeof forms)[number]) => (
          <li key={`${form.title}-${form.law ?? ""}-${form.formLabel ?? ""}`}>
            <span className="research-issue-label">{form.title}{form.formLabel ? ` (${form.formLabel})` : ""}{form.law ? <span className="research-meta"> · {form.law}</span> : null}</span>
            <span className="research-issue-status" data-status={form.original === "verified" ? "found" : "none"}>{form.original === "verified" ? "원문 확인됨" : form.original === "identified" ? "원문 일부 확인됨" : "원문 미확보"}</span>
            {form.articles.length > 0 && <span className="research-meta">근거: {form.articles.map((article) => `${article.law} ${article.jo}`).join(" · ")}</span>}
            {(() => { const target = form.articles.map((article) => lawJoTargets.get(`${article.law}\u0000${article.jo}`)).find(Boolean);
              return target ? sourceJump(target, "상세 근거에서 원문 보기") : null; })()}
          </li>);
        return <div className="research-original research-issues is-assessed" data-procedure-forms="true">
          <span>02 {formsReq.label}</span>
          <span className="research-issue-status" data-status={formsReq.status}>{PROCEDURE_REQUIREMENT_LABEL[formsReq.status]}</span>
          {required.length > 0 && <><p className="research-meta">필수 제출서류</p><ul>{required.map(formRow)}</ul></>}
          {conditional.length > 0 && <><p className="research-meta">조건부 제출서류</p><ul>{conditional.map(formRow)}</ul></>}
          <p className="research-meta">관련 법령 서식 목록은 아래에서 확인하세요. 의무의 적용 대상·조건과 서식 외 첨부서류는 근거 조문에서 확인하세요.</p>
          {formsReq.related && formsReq.related.length > 0 && <p className="research-meta">관련 조문(직접 근거 아님): {formsReq.related.map((article) => `${article.law} ${article.jo}`).join(" · ")}</p>}
        </div>;
      })()}
      {/* "확인한 요구사항" top block removed: its procedure verdict now
        rides on the 01 steps header, its forms verdict on the 02 header,
        and its article/annex lists live once in the group sections below.
        procedure.requirements data itself is untouched (verdicts, notices
        and counts above still read it). Cost/general requirements lose
        their top row; their articles stay in the group sections. */}
      <ResearchSummaryNotices>
        {notice && <ResearchSummaryNotice tone="error" title="일부 자료 조회 미완료" className="legal-research-partial">{notice}</ResearchSummaryNotice>}
        {confirmationGap && <ResearchSummaryNotice tone="warning" title={confirmationGap.title}>{gapText}</ResearchSummaryNotice>}
        {status === "failed" && !notice && followupSeverity !== "error" && <ResearchSummaryNotice tone="error" title="자료 조회 미완료">자료 조회를 완료하지 못했습니다. 조회 실패는 관련 근거가 없다는 뜻이 아닙니다.</ResearchSummaryNotice>}
        {!confirmationGap && (status === "weak" || status === "viewed") && <ResearchSummaryNotice tone="info" title="직접 관련성 확인 필요">조회된 자료가 질문과 직접 관련되는지 확인되지 않았습니다. 아래 자료는 참고용입니다.</ResearchSummaryNotice>}
        {procedure && annexOriginalGap && annexNoticeText && !confirmationGap?.kinds.includes("서식 원문")
          && <ResearchSummaryNotice tone={annexDirectGap ? "warning" : "info"} title="별표·서식 원문 미확보">{annexNoticeText}</ResearchSummaryNotice>}
        {followupSeverity && followupNoticeText && !followupInGap && <ResearchSummaryNotice tone={followupSeverity} title={followupNoticeTitle}>{followupNoticeText}</ResearchSummaryNotice>}
        {procedure && procedure.steps !== undefined && procedure.steps.length === 0
          && procedure.requirements.some((requirement) => requirement.kind === "procedure") && !confirmationGap?.kinds.includes("procedure")
          && <ResearchSummaryNotice tone="warning" title="절차 상세 확인 필요">단계별 절차를 구성할 근거 조문을 확인하지 못했습니다. 확보한 조문은 아래에서 확인하세요.</ResearchSummaryNotice>}
      </ResearchSummaryNotices>
      {taskEvidence && taskEvidence.items.length > 0 && <div className="research-original research-issues is-assessed" data-task-evidence>
        <span>확인한 항목</span>
        {isLawSystem && <p className="research-meta">위임: 법률이 세부 사항을 시행령·시행규칙 등에서 정하도록 맡기는 것</p>}
        {isLawSystem && askedLawArticles.length > 0 && <p className="research-meta">질문 대상 조항: {askedLawArticles.join(" · ")}</p>}
        <ul>{taskItems.map((item, index) => {
          // Law-system core result: each asked tier's delegation verdict and
          // the provisions directly linked to the asked article (names only).
          // Other provisions, wording and excerpts live once in the tier
          // detail below; category counts are never summed into a total.
          if (isLawSystem) {
            const summary = lawSystemTopSummary(item);
            const lawTier = item.label === "법률";
            return <li key={`${item.label}-${index}`}>
              <span className="research-issue-label"><span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>{item.label}{item.optional ? <span className="research-meta"> (참고)</span> : null}</span>
              <span className="research-issue-status" data-status={item.status}>{(lawTier ? LAW_TIER_LABEL : LAW_SYSTEM_TIER_LABEL)[item.status]}</span>
              {lawTier && item.detail && <span className="research-meta">{item.detail}</span>}
              {!lawTier && summary && <span className="research-meta">{summary}</span>}
            </li>;
          }
          // Same rule for the other tasks: label + status at the top, and
          // the detail text only when the item has no provisions to show
          // below (a bare count/list detail is itself a repeat, so it is
          // not shown next to a provision list that lives below).
          return <li key={`${item.label}-${index}`}>
            <span className="research-issue-label"><span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>{item.title ?? item.label}{item.optional ? <span className="research-meta"> (참고)</span> : null}</span>
            <span className="research-issue-status" data-status={item.status}>{TASK_EVIDENCE_LABEL[item.status]}</span>
            {!item.references?.length && item.detail && <span className="research-meta">{item.detail}</span>}
          </li>;
        })}</ul>
      </div>}
      {verifiedAnnexes.length > 0 && <div className="research-original research-issues is-assessed" data-annexes-verified>
        <span>확인한 별표·서식 원문</span>
        <ul>{verifiedAnnexes.map((annex, index) => <li key={`${annex.law}-${annex.label}-${index}`}>
          <span className="research-issue-label">{annex.law} {annex.label}{annex.title ? ` (${annex.title})` : ""}</span>
          {annex.url && <span className="research-meta"><a href={annex.url} target="_blank" rel="noreferrer">법제처 원문 보기</a></span>}
          {data.task === "action_basis" && annex.relevance === "direct" && <span className="research-meta">{annex.sourceArticle} 인용 별표 · 질문에 구체적인 위반행위가 없어 개별 기준을 특정하지 않았습니다. 해당 위반행위의 기준은 원문 표에서 확인하세요.</span>}
          {annex.text && <details className="law-detail-source research-more">
            <SourceToggleSummary label="별표 원문 보기" openLabel="별표 원문 접기" />
            <AnnexOriginal text={annex.text} />
          </details>}
        </li>)}</ul>
      </div>}
      {identifiedAnnexes.length > 0 && <div className="research-original research-issues is-assessed" data-annexes-partial>
        <span>원문 일부만 확인된 별표·서식</span>
        <ul>{identifiedAnnexes.map((annex, index) => <li key={`${annex.law}-${annex.label}-${index}`}>
          <span className="research-issue-label">{annex.law} {annex.label}{annex.title ? ` (${annex.title})` : ""}</span>
          {annex.url && <span className="research-meta"><a href={annex.url} target="_blank" rel="noreferrer">법제처 원문 보기</a></span>}
        </li>)}</ul>
        <p className="research-meta">원문 전체가 확인되지 않았습니다. 전체 내용은 법제처 원문 보기에서 확인하세요.</p>
      </div>}
      {unrecoveredAnnexes.length > 0 && <div className="research-original research-issues is-assessed" data-annexes-missing>
        <span>원문 미확보 별표·서식</span>
        <ul>{unrecoveredAnnexes.map((annex, index) => <li key={`${annex.law}-${annex.label}-${index}`}>
          <span className="research-issue-label">{annex.law} {annex.label}{annex.title ? ` (${annex.title})` : ""}</span>
        </li>)}</ul>
        <p className="research-meta">원문을 확보하지 못했습니다. 해당 별표·서식의 세부 기준은 법제처에서 직접 확인하세요.</p>
      </div>}
    </ResearchResultSummary>
    {/* Only when there is no top issue list to reuse (uninterpreted result):
        with an interpretation, the list above already carries the jump buttons. */}
    {full && !interpretation && issueEvidence.length > 1 && <nav className="research-issue-nav" aria-label="쟁점 바로가기">
      <span>쟁점 바로가기</span>
      <ol>{issueEvidence.map((issue, index) => <li key={`${issue.label ?? ""}-${index}`}>
        <Button type="button" variant="outline" size="sm" aria-controls={`research-issue-${index + 1}`} onClick={() => showIssue(index)}>
          <span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>
          <span className="research-issue-nav-label">{issue.label || "질문 쟁점"}</span>
          <ArrowDownRight aria-hidden="true" />
        </Button>
      </li>)}</ol>
    </nav>}
    {full && (issueEvidence.length > 0 || selectedArticles.length > 0 || selectedCases.length > 0) && <section className="research-group research-selected" aria-label="확인한 근거">
      <div className="research-evidence-heading">
        {/* The count is confirmed issues only: the old total counted unconfirmed issues too, so a fully unconfirmed section still read as "확인된 쟁점 N건". */}
        <h3>{(() => { const confirmed = issueEvidence.filter((issue) => issue.status === "found" && (selectedArticles.some((article) => issue.articles.some((ref) => ref.law === article.law && ref.jo === article.jo)) || issue.precedents.some((id) => caseOf.has(id)))).length; return confirmed ? <>확인된 쟁점 <span className="research-meta">{confirmed}건</span></> : "확인한 근거"; })()}</h3>
      </div>
      <p className="research-meta">질문 쟁점과 내용이 맞는 법제처 자료입니다. 법령의 적용 여부나 판결의 결론까지 확인했다는 뜻은 아닙니다</p>
      {hasIssueReferences && <div className="research-evidence-heading">
        <h3 id="research-details-heading">상세 근거</h3>
        <Button type="button" variant="ghost" size="xs" className="research-expand" aria-describedby="research-details-heading" aria-pressed={allReferencesOpen}
          onClick={() => {
            setReferencesOpen(!allReferencesOpen);
            onExpandSourcesChange(!allReferencesOpen);
          }}>{allReferencesOpen ? "전체 접기" : "전체 펼치기"} <ChevronDown aria-hidden="true" /></Button>
      </div>}
      {(() => {
        const renderedArticleKeys = new Set<string>();
        const articleItem = (article: (typeof selectedArticles)[number]) => {
          const key = articleDisplayKey(article);
          const target = selectedTargets.get(key);
          if (renderedArticleKeys.has(key) && target) return <li key={key}>
            <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
            {sourceJump(target, "공통 근거 원문 보기")}
          </li>;
          renderedArticleKeys.add(key);
          const excerpt = readerText(article.excerpt);
          const effective = formatDate(article.effective);
          const currency = data.evidence?.articles?.find((item) => item.law === article.law && item.jo === article.jo)?.currency;
          return <li key={`${article.law}-${article.jo}`} id={target} tabIndex={-1} className="research-source-target">
            <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
            <LawTextBlock className="legal-analysis-lines" text={excerpt} />
            {mcpTruncated(excerpt) && <p className="research-meta">중략된 발췌입니다. 조문 전문은 법령 검색에서 확인하세요.</p>}
            {(effective || currency) && <span className="research-meta" data-currency={currency}>
              {[currency && CURRENCY_LABEL[currency], effective && `시행 ${effective}`].filter(Boolean).join(" · ")}
            </span>}
            {(() => { const url = lawSourceUrl(article.law, article.jo);
              return url ? <span className="research-meta"><a href={url} target="_blank" rel="noreferrer">법제처 원문 보기</a></span> : null; })()}
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
              ? <LawTextBlock className="legal-analysis-raw" text={excerpt} />
              : <p className="research-meta">판시사항 발췌를 표시할 수 없습니다. 아래 조회 원자료도 대조해 주세요</p>}
          </li>;
        };
        const groups: IssueEvidence[] = issueEvidence.length ? issueEvidence
          : [{ status: "found", articles: data.evidence?.articles ?? [], precedents: data.evidence?.precedents ?? [] }];
        return groups.map((group, index) => {
          const articles = selectedArticles.filter((article) => group.articles.some((item) => item.law === article.law && item.jo === article.jo));
          const cases = selectedCases.flatMap((entry) => {
            const id = group.precedents.find((reference) => caseOf.get(reference) === entry.id);
            if (!id) return [];
            return [{ ...entry, ...caseEntries.find((item) => item.id === id), id }];
          });
          return <section key={`${group.label ?? ""}-${index}`} id={`research-issue-${index + 1}`} className="legal-analysis-section research-issue-evidence" data-status={group.status} data-issue-index={index}>
            <h3 tabIndex={-1}><span className="research-issue-number">{String(index + 1).padStart(2, "0")}</span>{group.label || "질문 쟁점"}</h3>
            <dl className="research-issue-findings">
              <div><dt>핵심 검토 결과</dt><dd>{articles.length + cases.length > 0
                ? `이 쟁점과 내용이 맞는 법령 ${articles.length}건·판례 ${cases.length}건을 확인했습니다. 구체적인 사건의 법적 결론은 아닙니다.`
                : ISSUE_GAP[group.status]}</dd></div>
              <div><dt>근거 상태</dt><dd className="research-issue-status" data-status={group.status}>{group.status === "found" && articles.length + cases.length === 0 ? "표시 근거 없음" : ISSUE_STATUS_LABEL[group.status]}</dd></div>
              <div><dt>추가 확인</dt><dd>{group.status === "failed" || group.status === "timeout"
                ? "조회되지 않은 자료를 원문에서 추가로 확인해야 합니다."
                : articles.length + cases.length > 0
                  ? "원문 시행 시점과 구체적인 사실관계에 대한 적용 여부를 대조해 주세요."
                  : "이 쟁점에 맞는 자료를 찾지 못했습니다. 질문에 사실관계를 더하면 다시 확인할 수 있습니다."}</dd></div>
            </dl>
            {articles.length + cases.length > 0 && <ul className="research-hits research-core-sources" aria-label="핵심 법적 근거">
              {articles.map((article) => <li key={`${article.law}-${article.jo}`}>
                <strong>{articleHeadingText(article.law, article.jo, article.title)}</strong>
                <span className="research-meta">쟁점 관련 근거 · {CURRENCY_LABEL[data.evidence?.articles?.find((item) => item.law === article.law && item.jo === article.jo)?.currency ?? "unconfirmed"]}{formatDate(article.effective) ? ` · 시행 ${formatDate(article.effective)}` : ""}</span>
                {selectedTargets.get(articleDisplayKey(article)) && sourceJump(selectedTargets.get(articleDisplayKey(article))!)}
              </li>)}
              {cases.map((entry) => <li key={entry.id}><strong>{caseName(entry)}</strong>
                <span className="research-meta">쟁점 관련 판례 · {entry.caseNumber ?? `자료 ${entry.id}`}</span>
              </li>)}
            </ul>}
            {articles.length + cases.length > 0 && <details className="law-detail-source research-issue-refs" onToggle={syncReferences}>
              <SourceToggleSummary label={`관련 법령·판례 상세 보기 · ${articles.length + cases.length}건`} openLabel="관련 법령·판례 상세 접기" />
              <ul className="research-hits">{articles.map(articleItem)}{cases.map(caseItem)}</ul>
            </details>}
          </section>;
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
      <p className="research-meta">조문은 법제처 자치법규 원문에서 조회했습니다. 나란히 놓인 원문은 차이의 법적 의미를 판단한 결과가 아닙니다</p>
    </section>}
    {(taskItems.some(hasTaskDetail) || askedLawRefs.length > 0) && <section className="research-group research-task-details" aria-label={isLawSystem ? "법령 단계별 관계" : "항목별 법적 근거"}>
      <h3>{isLawSystem ? "법령 단계별 관계" : "항목별 법적 근거"}</h3>
      <p className="research-meta">표시되는 발췌는 원문의 일부일 수 있습니다. 조문 전문은 발췌 아래의 법제처 원문 보기에서 확인하세요.</p>
      {askedLawRefs.length > 0 && <div className="legal-analysis-section">
        <h3>법률 <span className="research-issue-status" data-status="found">질문 대상 조문</span></h3>
        <details className="law-detail-source research-more">
          <SourceToggleSummary label="상세 검증 내용 보기" openLabel="상세 검증 내용 접기" />
          <ul className="research-hits">{askedLawRefs.map((article, articleIndex) => taskReferenceItem(article, `law-${articleIndex}`))}</ul>
        </details>
      </div>}
      {taskItems.map((item, index) => {
        if (!hasTaskDetail(item)) return null;
        const tierLabel = isLawSystem ? (item.label === "법률" ? LAW_TIER_LABEL : LAW_SYSTEM_TIER_LABEL) : TASK_EVIDENCE_LABEL;
        const groups = isLawSystem ? groupLawSystemArticles(item.references.filter((article): article is TaskEvidenceArticle => "relation" in article)) : [];
        const directGroups = groups.filter((group) => group.key === "direct");
        const extraGroups = groups.filter((group) => group.key !== "direct");
        const extraCount = extraGroups.reduce((count, group) => count + group.articles.length, 0);
        const groupList = (group: (typeof groups)[number]) => <div key={group.key}>
          <p className="research-meta">{group.label}</p>
          <ul className="research-hits">{group.articles.map((article, articleIndex) => taskReferenceItem(article, `${group.key}-${articleIndex}`))}</ul>
        </div>;
        const directRefs = item.references.filter((article) => !("note" in article && article.note));
        const supportingRefs = item.references.filter((article) => "note" in article && article.note);
        return <div key={index} id={`research-task-evidence-${index + 1}`} className="legal-analysis-section research-source-target" tabIndex={-1}>
          <h3 tabIndex={-1}>{item.title ?? item.label}{item.optional ? <span className="research-meta"> (참고)</span> : null} <span className="research-issue-status" data-status={item.status}>{tierLabel[item.status]}</span></h3>
          <details className="law-detail-source research-more">
            <SourceToggleSummary label="상세 검증 내용 보기" openLabel="상세 검증 내용 접기" />
            {item.detail && <p className="research-meta">{item.detail}</p>}
            {data.task === "action_basis" && <p className="research-meta">{directRefs.length === 0 && "이 항목의 직접 근거 문언을 확인하지 못했습니다. "}구체적인 사실관계의 적용 여부는 원문과 대조해야 합니다. 요건 충족 여부는 판단하지 않았습니다.</p>}
            {isLawSystem ? <>
              {directGroups.map(groupList)}
              {directGroups.length === 0 && <p className="research-meta">질문한 조항을 직접 인용하는 {item.label} 조문을 확인하지 못했습니다. 아래 조문은 관계 확인이 필요한 조회 자료입니다.</p>}
              {extraCount > 0 && <details className="law-detail-source research-more research-extra">
                <SourceToggleSummary label={`추가 조회 조문 보기 · ${extraCount}건`} openLabel="추가 조회 조문 접기" />
                {extraGroups.map(groupList)}
              </details>}
            </> : <>
              {directRefs.length > 0 && <ul className="research-hits">{directRefs.map((article, articleIndex) => taskReferenceItem(article, articleIndex))}</ul>}
              {supportingRefs.length > 0 && <>
                <p className="research-meta">보충 근거 — 직접 근거와 구분되는 관련 규정</p>
                <ul className="research-hits">{supportingRefs.map((article, articleIndex) => taskReferenceItem(article, `supporting-${articleIndex}`))}</ul>
              </>}
            </>}
          </details>
        </div>;
      })}
    </section>}
    {/* "절차 항목별 근거" section removed: step excerpts moved into the
      01 steps block above, step/form refs now jump straight to the
      detailed-evidence article in the group sections below, and
      requirement articles stay in those group sections. The
      procedure.requirements data itself is untouched. Note: a
      requirement article's nature label (필수/조건부/…) no longer has a
      dedicated row here; the 02 forms block carries the same duty
      classification per form. */}
    {taskGroups.map((group) => {
      // A duplicated annex list (same entries under two headings) renders
      // once: the server aggregate already counts it once, and the screen
      // must not show it as two lists.
      // 법체계 확인: the tier relation section above is the single home for
      // the 3단 비교 provisions and the follow-up reads behind them (and a
      // bare law-ID metadata line says nothing new); the raw listing stays in
      // 출처 원문 전체 보기.
      const sections = mergeDuplicateAnnexSections(candidatePrimary).filter((section) => groupOf(section, data.task) === group
        && !(data.task === "law_system" && taskItems.some(hasTaskDetail)
          && (/3단 비교|법령 체계|추가 조회 조문|위임 대조 추가 조회/u.test(section.heading ?? "")
            || (!section.heading && section.lines.every((line) => !line.trim() || /^\s*법령ID\s*:/u.test(line))))));
      if (!sections.length) return null;
      return <section key={group} className="research-group" data-group={group}>
        <h3>{GROUP_LABELS[data.task === "document_review" ? "full_research" : data.task][group] ?? "참고 자료"}</h3>
        {sections.map((section, index) => <ResearchSectionView key={index} section={section} task={data.task}
          relevance={data.enrichment?.precedents} retried={/해석례/u.test(section.heading ?? "") ? data.enrichment?.interpretations : undefined}
          lawSystem={data.lawSystem}
          articleTarget={(articleIndex) => primaryTarget(candidatePrimary.indexOf(section), articleIndex)}
          sourceTargets={sourceTargets} onSourceSelect={showSource} />)}
      </section>;
    })}
    {supporting.length > 0 && <section className="legal-analysis-section research-supporting">
      <h3>상세 근거</h3>
      {/* The material this answer drew on first; whole-law tables of contents are a browsing aid, so they come after. */}
      {[...supporting].sort((a, b) => Number(a.kind === "law_toc") - Number(b.kind === "law_toc")).map((section, index) => {
        const heading = sectionHeading(section) || "상세 자료";
        const label = section.kind === "law_toc" && section.toc
          ? `${section.toc.law ? `${lawDisplayText(section.toc.law)} ` : ""}법령 목차 보기 · ${section.toc.count.toLocaleString("ko-KR")}개 조문`
          : heading;
        return <details key={index} className="law-detail-source" data-kind={section.kind}>
          <SourceToggleSummary label={label} openLabel={`${label} 접기`} />
          {section.kind === "law_toc" && <p className="research-meta">목차입니다. 조문 본문은 법령 검색에서 확인하세요.</p>}
          <LawTextBlock className="legal-analysis-raw" text={readerText(section.lines.join("\n"))} />
        </details>;
      })}
    </section>}
    <details className="law-detail-source research-source" open={full ? undefined : expandSources}>
      <SourceToggleSummary label="출처 원문 전체 보기" openLabel="출처 원문 접기" />
      {readerText(data.text).trim() ? <>
        <p className="research-meta">법제처 조회 응답과 추가 조회 내용을 읽기 좋게 정리한 표시본입니다. 인용 전에 시행 시점을 대조해 주세요</p>
        <LawTextBlock className="legal-analysis-raw" text={readerText(data.text)} />
      </> : <p className="research-meta">원문을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
    </details>
    {showSupplement && <section className="research-group" aria-label="추가 조회 자료">
      <SupplementView supplement={supplement} hasArticles={articleCount > 0} shownArticleKeys={taskArticleKeys}
        sourceTargets={sourceTargets} onSourceSelect={showSource} />
    </section>}
    <p className="legal-analysis-note">조회 경로: {result.sources.map((source) => source.replace(" OPEN API", "")).join(" · ")}. {RESULT_NOTE}</p>
  </div>;
}
