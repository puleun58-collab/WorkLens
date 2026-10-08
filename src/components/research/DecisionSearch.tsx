"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";
import {
  DECISION_SEARCH_ERROR, DECISION_TEXT_ERROR, decisionSearchOutcome, decisionTextOutcome,
  type DecisionEntry, type DecisionSearchOutcome, type DecisionTextData, type DecisionTextOutcome,
} from "@/lib/decision-search";
import { LAW_ANALYSIS_CASE_MAX_CHARS, LAW_ANALYSIS_CASE_PATTERN } from "@/lib/law-analysis";
import { decisionIdentifier, decisionSearchQuery, splitExactResults } from "@/lib/decision-identifier";
import { formatLawDate } from "@/lib/law-search";
import { LawTextBlock } from "./LawTextBlock";
import "./decision-search.css";

export interface LinkedDecisionSearch {
  query: string;
  lawName: string;
  jo: string;
  /** Defaults to 판례; an impact map's 해석례 follow-up opens 법령해석례. */
  domain?: DecisionDomain;
  /** Where "back" returns to: the law article (default) or the impact map that suggested the search. */
  origin?: "law" | "analysis";
}

interface DecisionSearchProps {
  linkedRequest: LinkedDecisionSearch | null;
  onReturnToLaw: () => void;
  /** Opens cite_check with the case number the decision search already parsed. */
  onCiteCheck: (caseNumber: string) => void;
}

export function DecisionSearch({ linkedRequest, onReturnToLaw, onCiteCheck }: DecisionSearchProps) {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<DecisionDomain>("precedent");
  const [page, setPage] = useState(1);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [outcome, setOutcome] = useState<DecisionSearchOutcome | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selected, setSelected] = useState<DecisionEntry | null>(null);
  const [detail, setDetail] = useState<DecisionTextOutcome | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const cachedTexts = useRef(new Map<string, { compact?: DecisionTextData; full?: DecisionTextData }>());

  useEffect(() => () => {
    searchRequest.current?.abort();
    detailRequest.current?.abort();
  }, []);

  const runSearch = useCallback(async (nextQuery: string, nextDomain: DecisionDomain, nextPage: number) => {
    const trimmed = nextQuery.trim();
    if (!trimmed) return;
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearchedQuery(trimmed);
    setPage(nextPage);
    setOutcome(null);
    setSearchLoading(true);
    try {
      const response = await fetch("/api/law/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: nextDomain, query: trimmed, page: nextPage }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!controller.signal.aborted) setOutcome(decisionSearchOutcome(response.ok, body));
    } catch {
      if (!controller.signal.aborted) setOutcome({ kind: "error", message: DECISION_SEARCH_ERROR });
    } finally {
      if (searchRequest.current === controller) {
        searchRequest.current = null;
        setSearchLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!linkedRequest) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      detailRequest.current?.abort();
      detailRequest.current = null;
      setDetailLoading(false);
      setFullLoading(false);
      setSelected(null);
      const domain = linkedRequest.domain ?? "precedent";
      setDomain(domain);
      setQuery(linkedRequest.query);
      void runSearch(linkedRequest.query, domain, 1);
    });
    return () => { active = false; };
  }, [linkedRequest, runSearch]);

  async function loadDetail(entry: DecisionEntry, full = false) {
    const key = `${entry.domain}\0${entry.id}`;
    const cached = cachedTexts.current.get(key);
    const text = full ? cached?.full : cached?.full ?? cached?.compact;
    if (text) {
      setDetail({ kind: "found", data: text });
      return;
    }
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    if (full) {
      setFullError(null);
      setFullLoading(true);
    } else {
      setDetail(null);
      setDetailLoading(true);
    }
    try {
      const response = await fetch("/api/law/decisions/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(full ? { domain: entry.domain, id: entry.id, full: true } : { domain: entry.domain, id: entry.id }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      const result = decisionTextOutcome(response.ok, body);
      if (result.kind === "found") {
        const data = full ? { ...result.data, expandable: false } : result.data;
        const stored = cachedTexts.current.get(key) ?? {};
        cachedTexts.current.set(key, full ? { ...stored, full: data } : { ...stored, compact: data });
        setDetail({ kind: "found", data });
      } else if (full) {
        setFullError(result.kind === "error" ? result.message : "전문을 찾을 수 없습니다. 기존 원문은 그대로 표시됩니다.");
      } else {
        setDetail(result);
      }
    } catch {
      if (!controller.signal.aborted) {
        if (full) setFullError(DECISION_TEXT_ERROR);
        else setDetail({ kind: "error", message: DECISION_TEXT_ERROR });
      }
    } finally {
      if (detailRequest.current === controller) {
        detailRequest.current = null;
        setDetailLoading(false);
        setFullLoading(false);
      }
    }
  }

  function openDetail(entry: DecisionEntry) {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetailLoading(false);
    setFullLoading(false);
    setFullError(null);
    setSelected(entry);
    void loadDetail(entry);
  }

  function backToResults() {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetailLoading(false);
    setFullLoading(false);
    setSelected(null);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    detailRequest.current?.abort();
    detailRequest.current = null;
    setSelected(null);
    void runSearch(decisionSearchQuery(domain, query), domain, 1);
  }

  function changeDomain(value: DecisionDomain) {
    searchRequest.current?.abort();
    searchRequest.current = null;
    detailRequest.current?.abort();
    detailRequest.current = null;
    setSearchLoading(false);
    setDetailLoading(false);
    setFullLoading(false);
    setDomain(value);
    setPage(1);
    setSearchedQuery("");
    setOutcome(null);
    setSelected(null);
  }

  const returnButton = linkedRequest && <Button variant="link" type="button" className="law-back-link h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={onReturnToLaw} title={`${linkedRequest.lawName} ${linkedRequest.jo}`}>
    {linkedRequest.origin === "analysis" ? "← 조문 영향도로" : "← 법령으로"}
  </Button>;

  if (selected) {
    const text = detail?.kind === "found" ? detail.data : null;
    // cite_check traces court precedents only; other domains' numbers are not court case numbers.
    const citeCaseNumber = selected.domain === "precedent" && selected.caseNumber
      && selected.caseNumber.length <= LAW_ANALYSIS_CASE_MAX_CHARS && LAW_ANALYSIS_CASE_PATTERN.test(selected.caseNumber)
      ? selected.caseNumber : null;
    return <div className="decision-search decision-detail">
      <div className="law-back-links">
        <Button variant="link" type="button" className="law-back-link h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={backToResults}>← 검색 결과로</Button>
        {returnButton}
      </div>
      {citeCaseNumber && <div className="decision-detail-actions"><Button variant="link" id="decision-cite-check" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => onCiteCheck(citeCaseNumber)}>판례 유효성 확인</Button></div>}
      <section aria-labelledby="decision-detail-heading" aria-busy={detailLoading || fullLoading}>
        <h2 id="decision-detail-heading">{text?.title || selected.title || selected.caseNumber || "판례·결정례 원문"}</h2>
        <p className="decision-search-meta">
          <span>{DECISION_DOMAINS.find((item) => item.value === selected.domain)?.label}</span>
          {selected.caseNumber && <span>{selected.caseNumber}</span>}
          {selected.court && <span>{selected.court}</span>}
          {selected.institution && <span>{selected.institution}</span>}
          {selected.date && <span>{formatLawDate(selected.date) ?? selected.date}</span>}
        </p>
        {detailLoading ? <p className="law-search-note" role="status">원문을 불러오는 중…</p>
          : detail?.kind === "error" ? <div className="decision-feedback" role="alert">
            <p className="law-search-error">{detail.message}</p>
            {selected.domain !== "nts" && <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => void loadDetail(selected)}>다시 시도</Button>}
          </div>
          : detail?.kind === "missing" ? <p className="law-search-note" role="status">원문을 찾을 수 없습니다.</p>
          : text ? <div className="decision-detail-content">
            {text.expandable === true && <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" disabled={fullLoading} onClick={() => void loadDetail(selected, true)}>
              {fullLoading ? "전문 불러오는 중…" : "전문 보기"}
            </Button>}
            {fullError && <p className="law-search-error law-operation-error" role="alert">{fullError}</p>}
            <LawTextBlock className="decision-detail-raw" text={text.text} />
          </div> : null}
      </section>
    </div>;
  }

  const identifier = outcome?.kind === "found" ? decisionIdentifier(domain, searchedQuery) : null;
  const split = identifier && outcome?.kind === "found" ? splitExactResults(domain, identifier, outcome.data.entries) : null;

  return <div className="decision-search">
    {returnButton}
    <form className="decision-search-form" role="search" onSubmit={submitSearch}>
      <div className="decision-search-fields">
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="decision-domain">자료 유형</Label>
          <Select items={DECISION_DOMAINS} value={domain} onValueChange={(value) => { if (value) changeDomain(value); }}>
            <SelectTrigger id="decision-domain"><SelectValue /></SelectTrigger>
            <SelectPopup>{DECISION_DOMAINS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="decision-query">검색어</Label>
          <Input id="decision-query" type="search" value={query} maxLength={200} placeholder="판례·결정례 검색어" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Button type="submit" className="law-search-button" disabled={searchLoading || !query.trim()}>{searchLoading ? "검색 중…" : "검색"}</Button>
      </div>
    </form>
    <span className="sr-only" role="status">{searchLoading ? "검색 중…" : ""}</span>
    {!searchLoading && outcome && <section className="decision-search-results" aria-labelledby="decision-results-heading">
      <h2 id="decision-results-heading">{split ? <>일치 결과<span className="law-section-count"> · {split.exact.length}건</span></>
        : <>검색 결과{outcome.kind === "found" && outcome.data.totalCount !== undefined ? <span className="law-section-count"> · {outcome.data.totalCount}건</span> : outcome.kind === "missing" ? <span className="law-section-count"> · 0건</span> : null}</>}</h2>
      {outcome.kind === "error" ? <p className="law-search-error law-operation-error" role="alert">{outcome.message}</p>
        : outcome.kind === "missing" ? <p className="law-search-note" role="status">검색 결과가 없습니다. 다른 검색어로 검색해보세요.</p>
        : <>
          {split ? <>
            {split.exact.length ? <DecisionList entries={split.exact} onOpen={openDetail} /> : <p className="law-search-note" role="status">
              {page > 1 || outcome.data.hasNext ? "이 페이지에서는 일치하는 자료를 찾지 못했습니다. 다른 페이지에 있을 수 있습니다." : "일치하는 자료를 찾지 못했습니다."}
            </p>}
            {split.others.length > 0 && <>
              <h3 className="decision-search-subheading">다른 검색 결과<span className="law-section-count"> · {split.others.length}건</span></h3>
              <DecisionList entries={split.others} onOpen={openDetail} />
            </>}
          </> : outcome.data.entries.length > 0 ? <DecisionList entries={outcome.data.entries} onOpen={openDetail} /> : <LawTextBlock className="decision-detail-raw" text={outcome.data.text} />}
          <div className="decision-pagination">
            {page > 1 && <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => void runSearch(searchedQuery, domain, page - 1)}>← 이전</Button>}
            {outcome.data.hasNext === true && <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => void runSearch(searchedQuery, domain, page + 1)}>다음 →</Button>}
          </div>
        </>}
    </section>}
  </div>;
}

function DecisionList({ entries, onOpen }: { entries: readonly DecisionEntry[]; onOpen: (entry: DecisionEntry) => void }) {
  return <ul className="decision-search-list">
    {entries.map((entry, index) => <li key={`${entry.domain}-${entry.id}-${index}`}>
      <Button variant="ghost" type="button" className="decision-search-result rounded-none" onClick={() => onOpen(entry)}>
        <strong>{entry.title || entry.caseNumber || "판례·결정례 원문"}</strong>
        {(entry.caseNumber || entry.court || entry.institution || entry.date) && <span className="decision-search-meta">
          {entry.caseNumber && entry.title && <span>{entry.caseNumber}</span>}
          {entry.court && <span>{entry.court}</span>}
          {entry.institution && <span>{entry.institution}</span>}
          {entry.date && <span>{formatLawDate(entry.date) ?? entry.date}</span>}
        </span>}
        {entry.summary && <span className="decision-search-summary">{entry.summary}</span>}
      </Button>
    </li>)}
  </ul>;
}
