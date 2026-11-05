import { z } from "zod";

// Imported before schema.ts is evaluated: configure Zod before the first object
// schema, otherwise its caught Function probe still violates production CSP.
z.config({ jitless: true });

export const CURRENT_FACT_FIELDS = ["purpose", "trigger", "inputs", "steps", "outputs", "exceptions", "humanDecisions", "systems", "cycle"] as const;
const field = z.enum(CURRENT_FACT_FIELDS);
const quote = z.object({
  source: z.enum(["name", "description", "attachmentSummary", "details.cycle", "details.inputs", "details.outputs", "details.humanSteps", "details.systems"]),
  quote: z.string().trim().min(1).max(500),
}).strict();
/** Source excerpts, not generated claims. Optional on stored diagnoses for legacy compatibility. */
export const axGroundingSchema = z.object({
  facts: z.array(quote.extend({ field }).strict()).max(40),
  conflicts: z.array(z.object({ field, left: quote, right: quote }).strict()).max(8),
}).strict();
export type AxGrounding = z.infer<typeof axGroundingSchema>;
