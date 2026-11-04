import { z } from "zod";
import { lawNamesInQuery } from "./law-identity";

export const researchSearchPlanSchema = z.object({ searches: z.array(z.object({
  issueIndex: z.number().int().nonnegative(), direction: z.enum(["conduct", "obligation", "procedure"]),
  query: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(160),
}).strict()).max(3) }).strict();
export type ResearchSearchDirection = z.infer<typeof researchSearchPlanSchema>["searches"][number];
const normalized = (text: string) => text.normalize("NFKC").replace(/[\s·ㆍ,?？]+/gu, "").toLowerCase();
/** Queries are discovery hints only. No invented statute identity can enter the retrieval boundary. */
export function validatedSearchDirections(original: string, issues: readonly { query: string }[], value: unknown): ResearchSearchDirection[] {
  const plan = researchSearchPlanSchema.parse(value);
  const originalNames = new Set(lawNamesInQuery(original).map(normalized));
  const numbers = new Set(original.match(/\d+/gu) ?? []);
  const seen = new Set<string>();
  return plan.searches.filter(search => {
    if (search.issueIndex >= issues.length || [...search.query.matchAll(/\d+/gu)].some(match => !numbers.has(match[0]))) return false;
    if (lawNamesInQuery(search.query).some(law => !originalNames.has(normalized(law)))) return false;
    const key = normalized(search.query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
