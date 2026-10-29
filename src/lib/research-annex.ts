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
}
