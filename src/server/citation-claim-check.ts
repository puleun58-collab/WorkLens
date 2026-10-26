/**
 * Server-side claim-support check for verify_citations results.
 *
 * The upstream verifier establishes existence only. For every citation the
 * verifier marked ✓, this module fetches the article text it actually
 * stands on (search_law to pin the current law by name, then get_law_text
 * for the article) and judges whether the input sentence's claim is
 * supported by that text.
 *
 * Failure handling is deliberately one-directional: any step that cannot be
 * completed (unparseable label, ambiguous current law, text lookup failure,
 * unexpected exception) yields "unverified", never "mismatch" and never
 * "supported". A failed check must not manufacture a verdict in either
 * direction; the client then shows the existence result with the
 * suitability explicitly unconfirmed.
 */
import { assessClaimSupport, type ClaimSupportEntry } from "@/lib/citation-claim";
import { lawCitationTarget } from "@/lib/citation-evidence";
import { verifyCitationsResult, type CitationItem } from "@/lib/law-analysis-parse";
import { getLawText, searchLaw } from "@/server/law-mcp";

type LawContext = { requestId: string; signal?: AbortSignal };

const stripTags = (text: string) => text.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ");
const firstLine = (text: string) => stripTags(text).split(/\n/u).map((line) => line.trim()).find(Boolean) ?? "";

function parseArticleTitle(text: string): string {
  const line = firstLine(text);
  const match = /제\s*\d+\s*조\s*(?:의\s*\d+)?\s*\(([^)]*)\)/u.exec(line);
  return match?.[1]?.trim() ?? "";
}

/** The single current law with this exact name, or null when it cannot be pinned. */
async function findCurrentLaw(name: string, context: LawContext) {
  const result = await searchLaw(name, context);
  if (!result.found) return null;
  const current = result.laws.filter((entry) => entry.name === name && (!entry.status || entry.status.includes("현행")));
  return current.length === 1 ? current[0] : null;
}

async function checkOne(
  input: string,
  item: CitationItem,
  index: number,
  context: LawContext,
): Promise<ClaimSupportEntry | null> {
  if (item.symbol !== "✓") return null;
  const target = lawCitationTarget(item.citation);
  if (!target) return { index, verdict: "unverified", reason: "인용 형식을 확인하지 못했습니다." };
  try {
    const law = await findCurrentLaw(target.lawName, context);
    if (!law || !law.mst) return { index, verdict: "unverified", reason: "해당 법령의 현행 조문 원문을 조회하지 못했습니다." };
    const textResult = await getLawText({ mst: law.mst }, target.jo, context);
    if (!textResult.found) return { index, verdict: "unverified", reason: "조문 원문 조회 실패로 근거 적합성을 확인하지 못했습니다." };
    const title = parseArticleTitle(textResult.text) || target.title || "";
    const assessment = assessClaimSupport(input, target.lawName, title, textResult.text);
    return { index, verdict: assessment.verdict, reason: assessment.reason };
  } catch {
    return { index, verdict: "unverified", reason: "조문 원문 조회 실패로 근거 적합성을 확인하지 못했습니다." };
  }
}

/**
 * Assesses every verified law citation in a verify_citations result.
 * Returns entries only for items that were assessed; callers match by index.
 */
export async function assessCitationClaims(
  input: string,
  mcpText: string,
  context: LawContext,
): Promise<ClaimSupportEntry[]> {
  const parsed = verifyCitationsResult(mcpText);
  const lawItems = parsed.items.filter((item) => item.group === "law");
  const results = await Promise.all(lawItems.map((item, index) => checkOne(input, item, index, context)));
  return results.filter((entry): entry is ClaimSupportEntry => entry !== null);
}
