import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { ResearchStatus } from "@/lib/research-status";

export type SummaryTone = "success" | "warning" | "error" | "info" | "neutral";

/** Presentation of an existing research status, with the labels 문서 검토 already shows. */
export const STATUS_BADGE: Record<ResearchStatus, { tone: SummaryTone; label: string }> = {
  matched: { tone: "success", label: "관련 근거 확인" },
  partial: { tone: "warning", label: "추가 확인 필요" },
  weak: { tone: "neutral", label: "근거 부족" },
  none: { tone: "neutral", label: "확인 근거 없음" },
  viewed: { tone: "neutral", label: "관련 자료 조회" },
  failed: { tone: "error", label: "조회 미완료" },
};

const BADGE_VARIANT = { success: "success", warning: "warning", error: "error", info: "info", neutral: "secondary" } as const;
function ToneIcon({ tone }: { tone: SummaryTone }) {
  if (tone === "neutral") return null;
  if (tone === "info") return <Info aria-hidden="true" />;
  return <svg className="research-status-icon size-[14px] opacity-100" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="12" fill="currentColor" />
    {tone === "success"
      ? <path d="m6.5 12 3.5 3.5 7.5-7.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      : <><path d="M12 6.5v6.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" /><circle cx="12" cy="17" r="1.2" fill="#fff" /></>}
  </svg>;
}

/**
 * One white result summary for every 종합 리서치 task: label and status badge, the result sentence,
 * then the caller's meta, notices and actions (as children, in reading order), then the reference note.
 */
export function ResearchResultSummary({ label, badge, title, status, caution, cautionClassName, children }: {
  label: ReactNode; badge?: { tone: SummaryTone; label: string }; title: ReactNode; status?: ResearchStatus;
  caution?: ReactNode; cautionClassName?: string; children?: ReactNode;
}) {
  return <header className="research-overview research-summary">
    <div className="research-summary-head">
      <span className="research-eyebrow">{label}</span>
      {badge && <Badge variant={BADGE_VARIANT[badge.tone]} className="research-summary-status" data-tone={badge.tone}><ToneIcon tone={badge.tone} />{badge.label}</Badge>}
    </div>
    <h3 className="legal-analysis-title" data-status={status}>{title}</h3>
    {children}
    {caution && <p className={`research-meta research-summary-caution${cautionClassName ? ` ${cautionClassName}` : ""}`}>{caution}</p>}
  </header>;
}

/** Status boxes below the meta line, separated from it by one rule. Renders nothing without notices. */
export function ResearchSummaryNotices({ children }: { children?: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return items.length ? <div className="research-summary-notices">{children}</div> : null;
}

export function ResearchSummaryNotice({ tone, title, className, children }: { tone: Exclude<SummaryTone, "neutral">; title: ReactNode; className?: string; children: ReactNode }) {
  return <Alert variant={tone} className={`research-summary-notice${className ? ` ${className}` : ""}`} data-tone={tone}>
    <ToneIcon tone={tone} />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription>{children}</AlertDescription>
  </Alert>;
}
