export interface AnnexEvidence {
  law: string;
  label: string;
  sourceArticle: string;
  citation: string;
  status: "verified" | "identified" | "not-found" | "failed";
  title?: string;
  text?: string;
  truncated?: boolean;
  /** Official current-form route, only after response identity is checked. */
  url?: string;
  /** Why this annex was read for the question: `direct` when the citing
   * provision concerns the question's legal act (or the question names the
   * annex), `related` when it was only lexically ranked. Absent on lists. */
  relevance?: "direct" | "related";
}
