import type { AxDiagnosis, AxTaskV2 } from "./types";
import { extractReviewableItems, reconcileReviews } from "./hitl";
import { taskStatus } from "./policy";

/** Apply a new AI diagnosis without replacing user-owned rule or review records.
 * Call with the latest task inside the state update, never the request snapshot.
 * Missing review targets stay in history; changed targets require reconfirmation.
 * AI-supplied decision points are never accepted as user decisions.
 */
export function applyRediagnosis(task: AxTaskV2, incoming: AxDiagnosis, now: string): AxTaskV2 {
  const diagnosis: AxDiagnosis = { ...incoming, decisionPoints: task.diagnosis?.decisionPoints };
  const reviews = task.reviews;
  const reconciled = reviews?.length && task.diagnosis
    ? reconcileReviews(reviews, extractReviewableItems(diagnosis))
    : undefined;
  const nextReviews = reconciled ? reviews?.map(review => {
    const status = reconciled.get(review.id)?.status;
    return review.status === "confirmed" && (status === "changed" || status === "ambiguous")
      ? { ...review, status: "stale" as const, updatedAt: now }
      : review;
  }) : reviews;
  return { ...task, diagnosis, status: taskStatus(diagnosis), ...(nextReviews ? { reviews: nextReviews } : {}), updatedAt: now };
}
