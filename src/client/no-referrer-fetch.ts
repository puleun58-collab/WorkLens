/**
 * Pins every request from a worker to "no referrer".
 *
 * huggingface.co answers 404 to a model request that carries a `Referer`, and
 * a 404 has no `Access-Control-Allow-Origin`, so the browser reports the
 * blocked response as a CORS failure and the download never starts. A worker
 * takes its referrer policy from the response that served the worker script,
 * which the app does not control on every host — Cloudflare's asset binding
 * served ours without one — so the policy is set on the request instead, where
 * it holds regardless of deployment.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function noReferrerFetch(base: FetchLike): FetchLike {
  return (input, init) => base(input, { ...init, referrerPolicy: "no-referrer" });
}
