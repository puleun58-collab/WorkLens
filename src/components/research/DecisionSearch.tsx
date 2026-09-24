"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DECISION_DOMAINS, type DecisionDomain } from "@/lib/decision-domain";
import {
  DECISION_SEARCH_ERROR, DECISION_TEXT_ERROR, decisionSearchOutcome, decisionTextOutcome,
  type DecisionEntry, type DecisionSearchOutcome, type DecisionTextData, type DecisionTextOutcome,
} from "@/lib/decision-search";
import "./decision-search.css";

export interface LinkedDecisionSearch {
  query: string;
  lawName: string;
  jo: string;
}

interface DecisionSearchProps {
  linkedRequest: LinkedDecisionSearch | null;
  onReturnToLaw: () => void;
}

export function DecisionSearch({ linkedRequest, onReturnToLaw }: DecisionSearchProps) {
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
      setDomain("precedent");
      setQuery(linkedRequest.query);
      void runSearch(linkedRequest.query, "precedent", 1);
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
    void runSearch(query, domain, 1);
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

  const returnButton = linkedRequest && <button type="button" className="law-search-link" onClick={onReturnToLaw} title={`${linkedRequest.lawName} ${linkedRequest.jo}`}>
    ← 법령으로
  </button>;

  if (selected) {
    const text = detail?.kind === "found" ? detail.data : null;
    return <div className="decision-search decision-detail">
      <div className="decision-detail-actions">
        <button type="button" className="law-search-link" onClick={backToResults}>← 검색 결과로</button>
        {returnButton}
      </div>
      <section aria-labelledby="decision-detail-heading" aria-busy={detailLoading || fullLoading}>
        <h2 id="decision-detail-heading">{text?.title || selected.title || selected.caseNumber || "판례·결정례 원문"}</h2>
        <p className="decision-search-meta">
          <span>{DECISION_DOMAINS.find((item) => item.value === selected.domain)?.label}</span>
          {selected.caseNumber && <span>{selected.caseNumber}</span>}
          {selected.court && <span>{selected.court}</span>}
          {selected.institution && <span>{selected.institution}</span>}
          {selected.date && <span>{selected.date}</span>}
        </p>
        {detailLoading ? <p className="law-search-note" role="status">원문을 불러오는 중…</p>
          : detail?.kind === "error" ? <div className="decision-feedback" role="alert">
            <p className="law-search-error">{detail.message}</p>
            {selected.domain !== "nts" && <button type="button" className="law-search-link" onClick={() => void loadDetail(selected)}>다시 시도</button>}
          </div>
          : detail?.kind === "missing" ? <p className="law-search-note" role="status">원문을 찾을 수 없습니다.</p>
          : text ? <div className="decision-detail-content">
            {text.expandable === true && <button type="button" className="law-search-link" disabled={fullLoading} onClick={() => void loadDetail(selected, true)}>
              {fullLoading ? "전문 불러오는 중…" : "전문 보기"}
            </button>}
            {fullError && <p className="law-search-error" role="alert">{fullError}</p>}
            <pre className="decision-detail-raw">{text.text}</pre>
          </div> : null}
      </section>
    </div>;
  }

  return <div className="decision-search">
    {returnButton}
    <form className="decision-search-form" role="search" onSubmit={submitSearch}>
      <div className="decision-search-fields">
        <label htmlFor="decision-domain">자료 유형
          <select id="decision-domain" value={domain} onChange={(event) => changeDomain(event.target.value as DecisionDomain)}>
            {DECISION_DOMAINS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label htmlFor="decision-query">검색어
          <input id="decision-query" type="search" value={query} maxLength={200} placeholder="판례·결정례 검색어" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="submit" className="law-search-button" disabled={searchLoading || !query.trim()}>{searchLoading ? "검색 중…" : "검색"}</button>
      </div>
    </form>
    <section className="decision-search-results" aria-labelledby="decision-results-heading" aria-busy={searchLoading}>
      <h2 id="decision-results-heading">검색 결과{outcome?.kind === "found" && outcome.data.totalCount !== undefined ? ` · ${outcome.data.totalCount}건` : ""}</h2>
      {searchLoading ? <p className="law-search-note" role="status">검색 중…</p>
        : !outcome ? <p className="law-search-note">자료 유형과 검색어를 선택해 검색하세요.</p>
        : outcome.kind === "error" ? <p className="law-search-error" role="alert">{outcome.message}</p>
        : outcome.kind === "missing" ? <p className="law-search-note" role="status">검색 결과가 없습니다. 다른 검색어로 검색해보세요.</p>
        : <>
          {outcome.data.entries.length > 0 ? <ul className="decision-search-list">
            {outcome.data.entries.map((entry, index) => <li key={`${entry.domain}-${entry.id}-${index}`}>
              <button type="button" className="decision-search-result" onClick={() => openDetail(entry)}>
                <strong>{entry.title || entry.caseNumber || "판례·결정례 원문"}</strong>
                {(entry.caseNumber || entry.court || entry.institution || entry.date) && <span className="decision-search-meta">
                  {entry.caseNumber && entry.title && <span>{entry.caseNumber}</span>}
                  {entry.court && <span>{entry.court}</span>}
                  {entry.institution && <span>{entry.institution}</span>}
                  {entry.date && <span>{entry.date}</span>}
                </span>}
                {entry.summary && <span className="decision-search-summary">{entry.summary}</span>}
              </button>
            </li>)}
          </ul> : <pre className="decision-detail-raw">{outcome.data.text}</pre>}
          <div className="decision-pagination">
            {page > 1 && <button type="button" className="law-search-link" onClick={() => void runSearch(searchedQuery, domain, page - 1)}>← 이전</button>}
            {outcome.data.hasNext === true && <button type="button" className="law-search-link" onClick={() => void runSearch(searchedQuery, domain, page + 1)}>다음 →</button>}
          </div>
        </>}
    </section>
  </div>;
}
