/**
 * Display-only normalization for raw text from the Korean Law MCP.
 *
 * The raw response stays untouched for markers, parsers and caching; only
 * what a `<pre>` shows is cleaned:
 *  - HTML line breaks (`<br>`, `<br/>`, `<BR />`) become real line breaks.
 *    Every other tag stays inert text; nothing is ever rendered as HTML.
 *  - MCP operator guidance is removed: sentences that tell an agent which
 *    tool to call next (`get_precedent_text(id="…")`, `find_similar_precedents
 *    사용`) or show raw search arguments (`body_search="…"`, `full=true`).
 *    Only sentences naming a known MCP tool or a raw `name=` argument are
 *    touched, so legal prose such as "다음과 같이 판결한다." is never altered.
 */
const LINE_BREAK_TAG = /<\s*\/?\s*br\s*\/?\s*>/giu;

/** Tools the Korean Law MCP names in its own output (observed in live responses). */
const MCP_TOOL = /\b(?:search_law|get_law_text|get_batch_articles|search_precedents|get_precedent_text|find_similar_precedents|search_decisions|get_decision_text|search_interpretations|get_interpretation_text|search_ai_law|get_article_history|legal_analysis|legal_research|discover_tools|execute_tool|chain_document_review)\b/u;
/** Raw MCP arguments; always `name=` immediately followed by a value. */
const RAW_ARGUMENT = /\b(?:body_search|query|display|page|full|id|domain|mst|jo|efYd|lawId)=(?:"[^"]*"|true|false|[\w.-]+)/u;
const OPERATOR_TEXT = new RegExp(`${MCP_TOOL.source}|${RAW_ARGUMENT.source}`, "u");
/** `(get_decision_text)` inside an otherwise useful sentence. */
const TOOL_PARENTHETICAL = new RegExp(`\\s*\\(\\s*${MCP_TOOL.source}(?:\\([^)]*\\))?\\s*\\)`, "gu");
/** `⋯ 중략 3,198자 (full=true로 전문 조회) ⋯` keeps the omission, drops the argument. */
const OMISSION_ARGUMENT = /\s*\(\s*full=true[^)]*\)/gu;
const SEARCH_ADJUSTMENT = /^\s*검색\s*보정\s*:\s*body_search=.*$/u;
/** Lines written for the calling agent, not for a reader: LLM instructions and internal API links. */
const AGENT_LINE = /\bLLM\b|^\s*링크:\s*\/DRF\//u;
/** What is left of a line whose guidance was removed: an icon and/or a bare label. */
const LEFTOVER_LABEL = /^[\s\p{Extended_Pictographic}\uFE0F]*(?:[^\s:：][^:：]{0,24}[:：])?[\s\p{Extended_Pictographic}\uFE0F]*$/u;

function withoutOperatorGuidance(raw: string): string | undefined {
  if (AGENT_LINE.test(raw)) return undefined;
  // `법령ID: 011357 | MST: 283839 | 구분: 법률`: MST is the API's version serial, not something a reader uses.
  const line = raw.replace(/\s*\|\s*MST:\s*\d+(?=\s*(?:\||$))/gu, "").replace(/^(\s*)MST:\s*\d+\s*\|\s*/u, "$1");
  if (!OPERATOR_TEXT.test(line)) return line;
  if (SEARCH_ADJUSTMENT.test(line)) return "검색어를 보정해 관련 결과를 찾았습니다.";
  const cleaned = line
    .replace(OMISSION_ARGUMENT, "")
    .split(/(?<=[.。])\s+/u)
    .map((sentence) => sentence
      .split(/\s+—\s+/u)
      // A tool named after a dash is the guidance itself; inside a first part it is only a parenthetical.
      .map((part, index) => (index === 0 ? part.replace(TOOL_PARENTHETICAL, "") : part))
      .filter((part) => !OPERATOR_TEXT.test(part))
      .join(" — "))
    .filter((sentence) => sentence.trim() !== "")
    .join(" ");
  return LEFTOVER_LABEL.test(cleaned) ? undefined : cleaned;
}

export function lawDisplayText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(LINE_BREAK_TAG, "\n")
    .split("\n")
    .flatMap((line) => {
      const shown = withoutOperatorGuidance(line);
      return shown === undefined ? [] : [shown.replace(/[ \t\u00a0]+$/u, "")];
    })
    .join("\n")
    // At most two blank lines in a row: 3+ newlines between paragraphs are layout noise.
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}
