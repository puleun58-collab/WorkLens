"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AMENDMENT_SCENARIOS, DISPUTE_DOMAINS, EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_DOCUMENT_MAX_CHARS, LAW_RESEARCH_DOCUMENT_MIN_CHARS,
  LAW_RESEARCH_ERROR, LAW_RESEARCH_NAME_MAX_CHARS, LAW_RESEARCH_QUERY_MAX_CHARS, LAW_RESEARCH_TASKS, lawResearchOutcome, lawResearchRequestFor,
  type AmendmentScenario, type DisputeDomain, type LawResearchData, type LawResearchDraft, type LawResearchOutcome,
  type LawResearchRequest, type LawResearchTask,
} from "@/lib/law-research";
import { isSupportingSection, researchResult, type ResearchDecision, type ResearchSection } from "@/lib/law-research-parse";
import { lawDisplayText } from "@/lib/law-display";
import { LawTextBlock } from "./LawTextBlock";
import { ContractReviewResult } from "./ContractReviewResult";
import { SourceToggleSummary } from "./SourceToggleSummary";
import "./legal-analysis.css";

interface TaskResult {
  request: LawResearchRequest;
  outcome: LawResearchOutcome | null;
  loading: boolean;
}

const QUERY_PLACEHOLDER: Record<Exclude<LawResearchTask, "document_review">, string> = {
  full_research: "예: 직장 내 괴롭힘 판단 기준",
  law_system: "예: 개인정보보호법 체계",
  action_basis: "예: 식품위생법 영업정지 근거",
  dispute_prep: "예: 부당해고 구제 절차와 관련 판례",
  amendment_track: "예: 근로기준법 최근 개정 내용",
  ordinance_compare: "예: 주차장법 관련 서울시 조례",
  procedure_detail: "예: 행정심판 청구 절차와 제출서류",
};

const TRANSMISSION_NOTE = "입력한 내용은 법률 검토를 위해 외부 법령 MCP 서버(Korean Law MCP)로 전송되며, WorkLens에 저장되지 않습니다.";
/** Document review analyzes the text on the WorkLens server; only issue-based search terms reach the MCP. */
const DOCUMENT_TRANSMISSION_NOTE = "문서 내용은 WorkLens 서버에서 조항별로 분석되며 저장되지 않습니다. 외부 법령 MCP 서버(Korean Law MCP)에는 조항 쟁점으로 만든 검색어만 전송됩니다.";
const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";

export function LegalResearch() {
  const [task, setTask] = useState<LawResearchTask>("full_research");
  const [draft, setDraft] = useState<LawResearchDraft>(EMPTY_RESEARCH_DRAFT);
  const [results, setResults] = useState<Partial<Record<LawResearchTask, TaskResult>>>({});
  const requests = useRef(new Map<LawResearchTask, AbortController>());

  useEffect(() => {
    const pending = requests.current;
    return () => pending.forEach((controller) => controller.abort());
  }, []);

  const run = useCallback(async (request: LawResearchRequest) => {
    requests.current.get(request.task)?.abort();
    const controller = new AbortController();
    requests.current.set(request.task, controller);
    setResults((current) => ({ ...current, [request.task]: { request, outcome: null, loading: true } }));
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
    setResults((current) => ({ ...current, [request.task]: { request, outcome, loading: false } }));
  }, []);

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

  const update = <K extends keyof LawResearchDraft>(key: K, value: LawResearchDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const current = results[task];
  const loading = current?.loading === true;
  const request = lawResearchRequestFor(task, draft);
  const isDocument = task === "document_review";
  const reversedDates = task === "amendment_track" && draft.scenario === "time_travel" && draft.fromDate && draft.toDate && draft.fromDate > draft.toDate;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (request && !loading) void run(request);
  }

  return <div className="legal-analysis legal-research">
    <form className="legal-analysis-form" onSubmit={submit} aria-label="종합 리서치 입력">
      <div className="legal-analysis-fields legal-research-options">
        <label htmlFor="research-task">리서치 유형
          <select id="research-task" value={task} onChange={(event) => changeTask(event.target.value as LawResearchTask)}>
            {LAW_RESEARCH_TASKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {task === "dispute_prep" && <label htmlFor="research-domain">분야
          <select id="research-domain" value={draft.domain} onChange={(event) => update("domain", event.target.value as DisputeDomain | "")}>
            {DISPUTE_DOMAINS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>}
        {task === "amendment_track" && <label htmlFor="research-scenario">추적 방식
          <select id="research-scenario" value={draft.scenario} onChange={(event) => update("scenario", event.target.value as AmendmentScenario | "")}>
            <option value="">자동</option>
            {AMENDMENT_SCENARIOS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>}
      </div>

      {isDocument ? <>
        <label htmlFor="research-document">검토할 문서 내용</label>
        <textarea id="research-document" value={draft.text} rows={10} maxLength={LAW_RESEARCH_DOCUMENT_MAX_CHARS} placeholder="계약서 또는 약관 등의 내용을 붙여 넣으세요." onChange={(event) => update("text", event.target.value)} aria-describedby="research-document-help" />
        <p id="research-document-help" className="legal-analysis-help">
          <span>{DOCUMENT_TRANSMISSION_NOTE}</span>
          <span className="legal-analysis-count">{draft.text.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_DOCUMENT_MAX_CHARS.toLocaleString("ko-KR")}자 · 최소 {LAW_RESEARCH_DOCUMENT_MIN_CHARS}자</span>
        </p>
      </> : <>
        <label htmlFor="research-query">질문 또는 검색어</label>
        <textarea id="research-query" value={draft.query} rows={3} maxLength={LAW_RESEARCH_QUERY_MAX_CHARS} placeholder={QUERY_PLACEHOLDER[task]} onChange={(event) => update("query", event.target.value)} aria-describedby="research-query-help"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <p id="research-query-help" className="legal-analysis-help">
          <span>{TRANSMISSION_NOTE}</span>
          <span className="legal-analysis-count">{draft.query.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_QUERY_MAX_CHARS.toLocaleString("ko-KR")}자</span>
        </p>
      </>}

      {task === "law_system" && <label htmlFor="research-articles" className="legal-research-single">관련 조문 (선택)
        <input id="research-articles" type="text" value={draft.articles} placeholder="예: 제38조, 제39조" onChange={(event) => update("articles", event.target.value)} />
      </label>}
      {task === "ordinance_compare" && <label htmlFor="research-parent-law" className="legal-research-single">상위 법령 (선택)
        <input id="research-parent-law" type="text" value={draft.parentLaw} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder="예: 주차장법" onChange={(event) => update("parentLaw", event.target.value)} />
      </label>}
      {task === "amendment_track" && <>
        {draft.scenario === "time_travel" && <div className="legal-analysis-fields legal-research-dates">
          <label htmlFor="research-from">시작일
            <input id="research-from" type="date" value={draft.fromDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("fromDate", event.target.value)} />
          </label>
          <label htmlFor="research-to">종료일
            <input id="research-to" type="date" value={draft.toDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("toDate", event.target.value)} />
          </label>
          {reversedDates && <p className="law-search-error" role="alert">시작일은 종료일보다 늦을 수 없습니다.</p>}
        </div>}
        <label className="image-tool-check legal-research-check">
          <input type="checkbox" checked={draft.includeHistory} onChange={(event) => update("includeHistory", event.target.checked)} /> 전체 개정 이력 포함
        </label>
      </>}

      <div className="legal-analysis-actions">
        <button type="submit" className="law-search-button" disabled={!request || loading}>
          {loading ? (isDocument ? "문서 검토 중…" : "리서치 중…") : isDocument ? "문서 검토" : "리서치 실행"}
        </button>
      </div>
    </form>

    {current && <section className="legal-analysis-result" aria-labelledby="research-result-heading" aria-busy={loading}>
      <h2 id="research-result-heading">{isDocument ? "검토 결과" : "리서치 결과"}</h2>
      {current.loading ? <p className="law-search-note" role="status">{isDocument ? "문서 검토 중…" : "리서치 중…"} 여러 자료를 함께 조회하므로 시간이 걸릴 수 있습니다.</p>
        : current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <button type="button" className="law-search-link" onClick={() => void run(current.request)}>다시 시도</button>
        </div>
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status">
          <p className="law-search-note">요청한 자료를 법제처 자료에서 찾지 못했습니다.</p>
          <LawTextBlock className="legal-analysis-raw" text={current.outcome.data.text} />
        </div>
        : current.outcome?.kind === "found" ? current.outcome.data.review
          ? <ContractReviewResult review={current.outcome.data.review} />
          : <ResearchResult data={current.outcome.data} />
        : null}
    </section>}
  </div>;
}

/** Search hits shown before the list folds; the rest of what the response contains stays one click away. */
const DECISION_PREVIEW = 3;
const ANNEX_PREVIEW = 5;

function formatDate(value?: string): string | undefined {
  return value && /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6)}` : value;
}

/** Heading without the MCP's bracketed status markers, which the partial notice already reports. */
const sectionHeading = (section: ResearchSection) => section.heading?.replace(/\s*\[[^\]]*\]/gu, "").trim();

function DecisionList({ entries }: { entries: ResearchDecision[] }) {
  return <ul className="research-hits">{entries.map((entry) => {
    const meta = [entry.caseNumber && `사건번호 ${entry.caseNumber}`, entry.body, formatDate(entry.date)].filter(Boolean).join(" · ");
    return <li key={entry.id}>
      <strong>{entry.title ?? entry.caseNumber ?? "제목 없음"}</strong>
      {meta && <span className="research-meta">{meta}</span>}
    </li>;
  })}</ul>;
}

function ResearchSectionView({ section, task }: { section: ResearchSection; task: LawResearchData["task"] }) {
  const heading = sectionHeading(section);
  const className = `legal-analysis-section${section.unavailable ? " is-unavailable" : ""}`;
  if (section.kind === "law_articles" && section.articles) {
    return <div className={className} data-kind={section.kind} data-markers={section.markers.join(" ")}>
      <h3>관련 법령·조문 <span className="research-meta">{section.articles.length}건</span></h3>
      <p className="research-meta">검색 결과에 포함된 조문 일부를 표시합니다.</p>
      <ul className="research-hits">{section.articles.map((article, index) => <li key={`${article.law}-${article.jo}-${index}`}>
        <strong>{article.law} {article.jo}{article.title ? ` ${article.title}` : ""}</strong>
        {article.excerpt && <LawTextBlock className="legal-analysis-lines" text={article.excerpt} />}
        {(article.effective || article.ministry) && <span className="research-meta">{[article.effective && `시행 ${article.effective}`, article.ministry].filter(Boolean).join(" · ")}</span>}
      </li>)}</ul>
    </div>;
  }
  if (section.kind === "decision_search" && section.decisions) {
    const { total, entries } = section.decisions;
    const rest = entries.slice(DECISION_PREVIEW);
    return <div className={className} data-kind={section.kind} data-markers={section.markers.join(" ")}>
      <h3>{heading} {total !== undefined && <span className="research-meta">검색 결과 총 {total.toLocaleString("ko-KR")}건</span>}</h3>
      <DecisionList entries={entries.slice(0, DECISION_PREVIEW)} />
      {rest.length > 0 && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`검색 결과 펼쳐보기 · ${rest.length}건 더`} openLabel="검색 결과 접기" />
        <DecisionList entries={rest} />
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
    return <div className={className} data-kind={section.kind} data-markers={section.markers.join(" ")}>
      <h3>{heading} {total !== undefined && <span className="research-meta">총 {total.toLocaleString("ko-KR")}건</span>}</h3>
      {list(entries.slice(0, preview))}
      {entries.length > preview && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`목록 펼쳐보기 · ${entries.length - preview}건 더`} openLabel="목록 접기" />
        {list(entries.slice(preview))}
      </details>}
    </div>;
  }
  return <div className={className} data-kind={section.kind} data-markers={section.markers.join(" ")}>
    {heading && <h3>{heading}</h3>}
    {section.lines.length > 0 && <LawTextBlock className="legal-analysis-lines" text={section.lines.join("\n")} />}
  </div>;
}

function ResearchResult({ data }: { data: LawResearchData }) {
  const result = researchResult(data.text);
  const unavailable = result.sections.filter((section) => section.unavailable).length;
  const supporting = result.sections.filter(isSupportingSection);
  return <div className="legal-analysis-output" data-task={data.task} data-markers={data.markers.join(" ")}>
    {result.title && <h3 className="legal-analysis-title">{result.title}</h3>}
    {unavailable > 0 && <p className="legal-research-partial" role="note">부분 결과입니다. {unavailable}개 항목은 조회하지 못했거나 시간 한도로 수집되지 않았습니다 (결과 없음과 다릅니다).</p>}
    {result.sections
      // A heading-less note that was only agent guidance has nothing left to show.
      .filter((section) => !isSupportingSection(section) && (section.heading || lawDisplayText(section.lines.join("\n"))))
      .map((section, index) => <ResearchSectionView key={index} section={section} task={data.task} />)}
    {supporting.length > 0 && <div className="legal-analysis-section research-supporting">
      <h3>상세 근거</h3>
      {supporting.map((section, index) => {
        const heading = sectionHeading(section) ?? "상세 자료";
        const label = section.kind === "law_toc" && section.toc
          ? `${section.toc.law ? `${section.toc.law} ` : ""}전체 목차 · ${section.toc.count.toLocaleString("ko-KR")}개 조문`
          : heading;
        return <details key={index} className="law-detail-source" data-kind={section.kind}>
          <SourceToggleSummary label={label} openLabel={`${label} 접기`} />
          <LawTextBlock className="legal-analysis-raw" text={section.lines.join("\n")} />
        </details>;
      })}
    </div>}
    <details className="law-detail-source">
      <SourceToggleSummary />
      <LawTextBlock className="legal-analysis-raw" text={data.text} />
    </details>
    <p className="legal-analysis-note">데이터 출처: {result.sources.join(" · ")}. {RESULT_NOTE}</p>
  </div>;
}
