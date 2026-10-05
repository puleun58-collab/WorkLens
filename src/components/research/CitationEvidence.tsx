"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  articleEvidence, articleLines, citedHo, lawCitationTarget, versionMatchesVerification, ymd,
  type ArticleEvidence, type LawCitationTarget,
} from "@/lib/citation-evidence";
import { decisionSearchOutcome, decisionTextOutcome, type DecisionEntry } from "@/lib/decision-search";
import { citationCounts, citationGroupLine, citationOverallLabel, type CitationGroupSummary, type CitationItem } from "@/lib/law-analysis-parse";
import { lawDisplayText } from "@/lib/law-display";
import { exactCurrentLaw, formatLawDate, lawOutcome, lawTextOutcome, type LawEntry } from "@/lib/law-search";
import { LawTextBlock } from "./LawTextBlock";
import { SourceToggleSummary } from "./SourceToggleSummary";

const SOURCE = "국가법령정보센터(법제처)";
const EVIDENCE_ERROR = "검증에 사용된 조문 원문을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.";
const VERSION_MISMATCH = "검증에 사용된 버전의 조문 원문을 불러오지 못했습니다. 검증 이후 법령이 바뀌었을 수 있으니 다시 검증해 주세요.";
const CASE_ERROR = "판례 정보를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.";

type LawEvidence =
  | { kind: "law"; law: LawEntry; evidence: ArticleEvidence }
  | { kind: "case"; entry: DecisionEntry; sections: { heading: string; text: string }[] };

type EvidenceState =
  | { status: "loading" }
  | { status: "ready"; value: LawEvidence }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

interface EvidenceTarget {
  key: string;
  item: CitationItem;
  law?: LawCitationTarget & { ho?: number };
  caseNumber?: string;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, body: await response.json().catch(() => null) };
}

/**
 * One request per distinct lookup: the law search is scoped to the
 * verification it serves, article text is keyed by its version (MST), and a
 * failed request is forgotten so "다시 시도" really retries.
 */
const requests = new Map<string, Promise<{ ok: boolean; body: unknown }>>();
function once(key: string, url: string, body: unknown) {
  let pending = requests.get(key);
  if (!pending) {
    pending = post(url, body).then((result) => {
      if (!result.ok) requests.delete(key);
      return result;
    }, (error: unknown) => {
      requests.delete(key);
      throw error;
    });
    requests.set(key, pending);
  }
  return pending;
}

async function loadLaw(target: NonNullable<EvidenceTarget["law"]>, verifiedAt: number): Promise<EvidenceState> {
  const search = await once(`law:${verifiedAt}:${target.lawName}`, "/api/law", { query: target.lawName }).then((r) => lawOutcome(r.ok, r.body));
  if (search.kind === "error") return { status: "error", message: EVIDENCE_ERROR };
  const law = search.kind === "found" ? exactCurrentLaw(search.laws, target.lawName) : undefined;
  if (!law?.mst) return { status: "unavailable", message: "검증에 사용된 법령을 법제처 자료에서 특정하지 못해 조문 원문을 표시할 수 없습니다." };
  if (!versionMatchesVerification(law.effectiveDate, ymd(new Date(verifiedAt)))) return { status: "unavailable", message: VERSION_MISMATCH };
  const response = await once(`text:${law.mst}:${target.jo}`, "/api/law/text", { mst: law.mst, jo: target.jo });
  const text = lawTextOutcome(response.ok, response.body);
  if (text.kind === "error") return { status: "error", message: EVIDENCE_ERROR };
  const lines = text.kind === "found" ? articleLines(text.data.text) : [];
  if (!lines.length) return { status: "unavailable", message: "법제처 자료에서 이 조문의 원문을 받지 못했습니다." };
  return {
    status: "ready",
    value: {
      kind: "law",
      law: { ...law, effectiveDate: text.kind === "found" ? text.data.effectiveDate ?? law.effectiveDate : law.effectiveDate },
      evidence: articleEvidence(lines, target.hang, target.ho),
    },
  };
}

async function loadCase(caseNumber: string): Promise<EvidenceState> {
  const search = await once(`case:${caseNumber}`, "/api/law/decisions/search", { domain: "precedent", query: caseNumber }).then((r) => decisionSearchOutcome(r.ok, r.body));
  if (search.kind === "error") return { status: "error", message: CASE_ERROR };
  const entries = search.kind === "found" ? search.data.entries.filter((entry) => entry.caseNumber === caseNumber) : [];
  if (entries.length !== 1) return { status: "unavailable", message: "검증된 사건번호와 정확히 일치하는 판례를 특정하지 못했습니다." };
  const [entry] = entries;
  const text = await once(`decision:${entry.id}`, "/api/law/decisions/text", { domain: "precedent", id: entry.id }).then((r) => decisionTextOutcome(r.ok, r.body));
  const sections = text.kind === "found"
    ? (text.data.sections ?? []).filter((section) => section.heading === "판시사항" || section.heading === "판결요지")
    : [];
  return { status: "ready", value: { kind: "case", entry, sections } };
}

function evidenceTargets(items: readonly CitationItem[], input: string): EvidenceTarget[] {
  const laws = items.filter((item) => item.group === "law");
  const parsed = laws.map((item) => lawCitationTarget(item.citation));
  const ho = citedHo(input, parsed);
  return items.map((item, index) => {
    const key = `${item.group}:${index}`;
    if (item.group === "law") {
      const position = laws.indexOf(item);
      const law = parsed[position];
      // Only an existing article has text to show: a confirmed citation, or one whose 항 lookup failed.
      const hasArticle = item.symbol === "✓" || (item.symbol === "⚠" && item.detail.startsWith("조문은 확인"));
      return { key, item, ...(law && hasArticle ? { law: { ...law, ho: ho[position] } } : {}) };
    }
    return { key, item, ...(item.group === "case" && item.symbol === "✓" ? { caseNumber: item.citation } : {}) };
  });
}

/**
 * The verifier checks 조 and 항 only; a cited 호 is confirmed against the
 * article text, so its status waits for that evidence.
 */
function effectiveItem(target: EvidenceTarget, state: EvidenceState | undefined): CitationItem {
  const { item, law } = target;
  if (!law?.ho || item.symbol !== "✓") return item;
  if (!state || state.status === "loading") return { ...item, label: "호 확인 중", tone: "unknown" };
  if (state.status === "ready" && state.value.kind === "law") {
    return state.value.evidence.kind === "found" ? item : { ...item, label: "찾을 수 없음", tone: "critical" };
  }
  return { ...item, label: "호 확인 필요", tone: "unknown" };
}

function citationLabel(target: EvidenceTarget): string {
  return target.law?.ho ? `${target.item.citation} 제${target.law.ho}호` : target.item.citation;
}

export function CitationResult({ items, groups, overallMarker, notes, input, verifiedAt }: {
  items: readonly CitationItem[];
  groups: readonly CitationGroupSummary[];
  overallMarker?: string;
  notes: ReactNode;
  input: string;
  verifiedAt: number;
}) {
  const targets = useMemo(() => evidenceTargets(items, input), [items, input]);
  const [states, setStates] = useState<Record<string, EvidenceState>>({});
  const started = useRef(new Set<string>());

  const load = useCallback((selected: readonly EvidenceTarget[]) => {
    for (const target of selected) {
      if (!target.law && !target.caseNumber) continue;
      if (started.current.has(target.key)) continue;
      started.current.add(target.key);
      setStates((current) => ({ ...current, [target.key]: { status: "loading" } }));
      const pending = target.law ? loadLaw(target.law, verifiedAt) : loadCase(target.caseNumber!);
      void pending.catch((): EvidenceState => ({ status: "error", message: target.law ? EVIDENCE_ERROR : CASE_ERROR })).then((state) => {
        if (state.status === "error") started.current.delete(target.key);
        setStates((current) => ({ ...current, [target.key]: state }));
      });
    }
  }, [verifiedAt]);

  // A cited 호 decides the citation's status, so it is checked without waiting for the disclosure.
  useEffect(() => {
    load(targets.filter((target) => target.law?.ho));
  }, [load, targets]);

  const shown = targets.map((target) => effectiveItem(target, states[target.key]));
  const hoPending = shown.some((item, index) => item !== targets[index].item && item.tone === "unknown");
  const hoMissing = shown.some((item, index) => item !== targets[index].item && item.tone === "critical");
  const marker = hoMissing ? "HALLUCINATION_DETECTED"
    : hoPending && (overallMarker === "VERIFIED" || overallMarker === "REPEALED_REFERENCE") ? "PARTIAL_VERIFIED"
      : overallMarker;
  const shownGroups = groups.map((group) => ({ ...group, counts: citationCounts(shown.filter((item) => item.group === group.group)) }));
  const byGroup = (["law", "case"] as const).map((group) => ({ group, entries: targets.flatMap((target, index) => target.item.group === group ? [{ target, item: shown[index] }] : []) }));
  const hasCases = targets.some((target) => target.caseNumber);

  return <>
    {marker && <p className="legal-analysis-overall" data-marker={marker}>{citationOverallLabel(marker)}</p>}
    <LawTextBlock className="legal-analysis-lines" text={shownGroups.map(citationGroupLine).join("\n")} />
    {byGroup.map(({ group, entries }) => entries.length ? <div key={group} className="legal-analysis-section">
      <h3>{group === "law" ? "법령 인용" : "판례 인용"}</h3>
      <ul className="legal-analysis-citations">
        {entries.map(({ target, item }) => <li key={target.key} className={`is-${item.tone}`} data-markers={item.markers.join(" ")}>
          <span className="legal-analysis-status">{item.label}</span>
          <span className="legal-analysis-citation-text">{lawDisplayText(citationLabel(target))}</span>
        </li>)}
      </ul>
    </div> : null)}
    {notes}
    {targets.length > 0 && <details className="law-detail-source" onToggle={(event) => { if (event.currentTarget.open) load(targets); }}>
      <SourceToggleSummary label="근거 보기" openLabel="근거 접기" />
      <p className="law-search-note">
        확인된 법령 조문과 판례 정보를 {SOURCE} 자료로 보여 줍니다. 법령은 검증 시점의 현행 법령 기준입니다.
        {hasCases ? " 판결문 전체 원문은 포함되지 않습니다." : ""}
      </p>
      {byGroup.map(({ group, entries }) => entries.length ? <div key={group} className="legal-analysis-section">
        <h3>{group === "law" ? "법령 인용" : "판례 인용"}</h3>
        {entries.map(({ target }) => <EvidenceEntry key={target.key} target={target} state={states[target.key]} onRetry={() => load([target])} />)}
      </div> : null)}
    </details>}
  </>;
}

function EvidenceEntry({ target, state, onRetry }: { target: EvidenceTarget; state?: EvidenceState; onRetry: () => void }) {
  const title = citationLabel(target);
  if (!target.law && !target.caseNumber) {
    return <div className="legal-analysis-evidence">
      <LawTextBlock className="legal-analysis-lines" text={target.item.detail ? `${title} — ${target.item.detail}` : title} />
    </div>;
  }
  return <div className="legal-analysis-evidence" data-evidence={state?.status ?? "idle"}>
    <h4>{lawDisplayText(title)}</h4>
    {!state || state.status === "loading" ? <p className="law-search-note" role="status">근거를 불러오는 중…</p>
      : state.status === "error" ? <p className="law-search-note">{state.message} <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={onRetry}>다시 시도</Button></p>
        : state.status === "unavailable" ? <p className="law-search-note">{state.message}</p>
          : state.value.kind === "law" ? <LawEvidenceView target={target} law={state.value.law} evidence={state.value.evidence} />
            : <CaseEvidenceView entry={state.value.entry} sections={state.value.sections} />}
  </div>;
}

function LawEvidenceView({ target, law, evidence }: { target: EvidenceTarget; law: LawEntry; evidence: ArticleEvidence }) {
  const scope = target.law?.ho ? `제${target.law.hang ? `${target.law.hang}항 제` : ""}${target.law.ho}호` : target.law?.hang ? `제${target.law.hang}항` : undefined;
  const meta = [
    law.effectiveDate && `시행일 ${formatLawDate(law.effectiveDate)}`,
    law.promulgationDate && `공포일 ${formatLawDate(law.promulgationDate)}`,
    law.mst && `법령 버전(MST) ${law.mst}`,
    `출처 ${SOURCE}`,
  ].filter(Boolean).join(" · ");
  return <>
    {evidence.kind === "part-missing" && <p className="law-search-note">인용한 {scope}을(를) 이 조문에서 찾지 못했습니다. 확인한 조문 범위를 아래에 표시합니다.</p>}
    <LawTextBlock className="legal-analysis-raw" text={evidence.lines.join("\n")} />
    <p className="legal-analysis-evidence-meta">{meta}</p>
  </>;
}

function CaseEvidenceView({ entry, sections }: { entry: DecisionEntry; sections: { heading: string; text: string }[] }) {
  const meta = [entry.court, entry.date && `${formatLawDate(entry.date)} 선고`, entry.caseNumber, entry.title].filter(Boolean).join(" · ");
  return <>
    <p className="legal-analysis-evidence-meta">{meta}</p>
    {sections.length
      ? sections.map((section) => <div key={section.heading} className="legal-analysis-evidence-part">
        <strong>{section.heading}</strong>
        <LawTextBlock className="legal-analysis-lines" text={section.text} />
      </div>)
      : <p className="law-search-note">이 판례의 판시사항·판결요지는 제공되지 않았습니다.</p>}
    <p className="legal-analysis-evidence-meta">출처 {SOURCE} · 판결문 전체 원문은 포함되지 않습니다.</p>
  </>;
}
