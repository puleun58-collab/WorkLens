import { listCompanyTerms, seedTerms } from "@/server/company-terms";
import { ok } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only company dictionary for every user. A D1 outage degrades to the
 * versioned seed list instead of taking the Check engine down with it.
 */
export async function GET() {
  try {
    const terms = await listCompanyTerms();
    return ok({ terms, source: "d1" as const });
  } catch {
    return ok({
      terms: seedTerms().map((term, index) => ({ id: -(index + 1), term, description: null, active: true, updatedAt: null })),
      source: "seed" as const,
    });
  }
}
