import { describe, expect, it } from "vitest";
import { retrieveResearchFollowup } from "@/server/research-followup";
import type { EnrichmentSources } from "@/server/research-enrichment";

/**
 * Round 4 (PR #347 gate A): law_system tier reads run in adjacent
 * score-order pairs (concurrency 2). These tests pin the invariants the
 * pairing must preserve — they do not test a Promise.all shape:
 * - at most 2 concurrent article reads, and only within one tier step;
 * - results applied in candidate order, not completion order;
 * - admission is checked synchronously at pair launch (started requests
 *   complete past the 15 s boundary; no new admission after it);
 * - the 18-key cap admits exactly one slot of a pair at 17 keys;
 * - other modes keep the sequential loop.
 */
const PARENT_BODY =
  "제38조(권리행사의 방법 및 절차)\n① 정보주체는 열람, 정정, 삭제, 처리정지, 수집에 관한 권리를 방법ㆍ절차에 따라 대리인에게 하게 할 수 있다. ③ 개인정보처리자는 대통령령으로 정하는 바에 따라 수수료와 우송료를 청구할 수 있다.";
const TOC_TITLES: Array<{ jo: string; title: string }> = [
  { jo: "제61조", title: "처리정지의 수수료" },
  { jo: "제63조", title: "처리정지의 우송료" },
  { jo: "제76조", title: "처리정지의 수집" },
  { jo: "제77조", title: "처리정지의 삭제" },
  { jo: "제78조", title: "처리정지의 정정" },
  { jo: "제79조", title: "수수료의 우송료" },
  { jo: "제70조", title: "수집의 수수료" },
  { jo: "제71조", title: "삭제의 수수료" },
  { jo: "제72조", title: "정정의 수수료" },
  { jo: "제73조", title: "수집의 우송료" },
  { jo: "제74조", title: "삭제의 우송료" },
  { jo: "제80조", title: "정정의 우송료" },
  { jo: "제60조", title: "처리정지의 방법" },
  { jo: "제62조", title: "수집의 삭제" },
  { jo: "제64조", title: "수집의 정정" },
  { jo: "제65조", title: "삭제의 정정" },
  { jo: "제45조", title: "대리인의 범위 등" },
  { jo: "제46조", title: "대리인의 확인" },
];
const QUERY = "개인정보보호법 제38조와 시행령의 관계";
const names = (followup: { articles: Array<{ law: string; jo: string }> }) =>
  followup.articles.map((a) => `${a.law} ${a.jo}`);

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
async function waitFor(cond: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await flush(1);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function deferredSources(options: {
  tocCount: number;
  citing: ReadonlySet<string>;
}) {
  const toc = TOC_TITLES.slice(0, options.tocCount);
  const pending = new Map<string, (v: { text: string } | undefined) => void>();
  const calls: string[] = [];
  let maxUnresolvedAtCall = 0;
  const s: EnrichmentSources = {
    async summary() { return undefined; },
    async laws(query) {
      if (query === "개인정보보호법") return [{ name: "개인정보 보호법", mst: "P" }];
      if (query === "개인정보 보호법 시행령") return [{ name: "개인정보 보호법 시행령", mst: "D" }];
      return [];
    },
    async toc(mst) { return mst === "D" ? toc : []; },
    async article(mst, jo) {
      calls.push(`${mst}/${jo}`);
      maxUnresolvedAtCall = Math.max(maxUnresolvedAtCall, pending.size + 1);
      if (mst === "P" && jo === "제38조") {
        return new Promise<{ text: string } | undefined>((resolve) => { pending.set(`${mst}/${jo}`, resolve); });
      }
      if (mst === "D") {
        const entry = toc.find((e) => e.jo === jo);
        if (!entry) return undefined;
        return new Promise<{ text: string } | undefined>((resolve) => { pending.set(`${mst}/${jo}`, resolve); });
      }
      return undefined;
    },
    async interpretations() { return []; },
    async precedents() { return []; },
  };
  const body = (mst: string, jo: string) => {
    if (mst === "P") return PARENT_BODY;
    return `${jo}(제목)\n${options.citing.has(jo) ? "법 제38조에 따라 대리인의 범위를 정한다." : "법 제35조에 따라 확인 방법을 정한다."}`;
  };
  const resolve = (mst: string, jo: string) => {
    const r = pending.get(`${mst}/${jo}`);
    if (!r) throw new Error(`no pending call for ${mst}/${jo}`);
    pending.delete(`${mst}/${jo}`);
    r({ text: body(mst, jo) });
  };
  return { sources: s, calls, pending, resolve, maxUnresolved: () => maxUnresolvedAtCall };
}

describe("round 4: law_system tier pairs", () => {
  it("reads at most 2 concurrently and applies results in candidate order", async () => {
    // 4 candidates score > 0, so the pairs are (제61조, 제63조) and (제76조, 제77조).
    const f = deferredSources({ tocCount: 4, citing: new Set(["제61조", "제63조"]) });
    const p = retrieveResearchFollowup("law_system", QUERY, "", undefined, f.sources, [], () => 0);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    await waitFor(() => f.calls.includes("D/제63조"), "pair 1 second call");
    // The pair overlapped: the first call is still unresolved when the second starts.
    expect(f.pending.has("D/제61조")).toBe(true);
    expect(f.maxUnresolved()).toBe(2);
    f.resolve("D", "제63조"); // reversed completion order
    f.resolve("D", "제61조");
    await waitFor(() => f.calls.includes("D/제77조"), "pair 2 calls");
    f.resolve("D", "제77조");
    f.resolve("D", "제76조");
    const followup = await p;
    expect(names(followup)).toEqual([
      "개인정보 보호법 제38조",
      "개인정보 보호법 시행령 제61조",
      "개인정보 보호법 시행령 제63조",
    ]);
    expect(f.maxUnresolved()).toBe(2);
  });

  it("completes a started pair past expiry but admits nothing after it", async () => {
    const f = deferredSources({ tocCount: 4, citing: new Set(["제61조", "제63조", "제45조"]) });
    let clock = 0;
    const p = retrieveResearchFollowup("law_system", QUERY, "", undefined, f.sources, [], () => clock);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    await waitFor(() => f.calls.includes("D/제63조"), "pair 1 calls");
    clock = 16000; // expiry lands while pair 1 is in flight
    f.resolve("D", "제61조");
    f.resolve("D", "제63조");
    const followup = await p;
    expect(names(followup)).toContain("개인정보 보호법 시행령 제61조");
    expect(names(followup)).toContain("개인정보 보호법 시행령 제63조");
    // Pair 2 (제76조, 제77조) was refused by the expired budget: no article calls for it.
    expect(f.calls.filter((c) => c === "D/제76조" || c === "D/제77조")).toEqual([]);
    expect(followup.report.limited).toBe(true);
  });

  it("admits a phase-2 pair launched at 14000 even if the clock passes 15000 in flight", async () => {
    const f = deferredSources({ tocCount: 8, citing: new Set(["제61조", "제63조", "제76조", "제77조", "제78조", "제79조", "제70조", "제71조"]) });
    let clock = 0;
    const p = retrieveResearchFollowup("law_system", QUERY, "", undefined, f.sources, [], () => clock);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    await waitFor(() => f.calls.includes("D/제63조"), "phase-1 pair 1");
    f.resolve("D", "제61조");
    f.resolve("D", "제63조");
    await waitFor(() => f.calls.includes("D/제77조"), "phase-1 pair 2");
    f.resolve("D", "제76조");
    f.resolve("D", "제77조");
    await waitFor(() => f.calls.includes("D/제79조"), "phase-1 pair 3");
    clock = 14000; // phase-2 launches under the boundary
    f.resolve("D", "제78조");
    f.resolve("D", "제79조");
    await waitFor(() => f.calls.includes("D/제71조"), "phase-2 pair calls");
    clock = 16000; // expiry lands while the phase-2 pair is in flight
    f.resolve("D", "제70조");
    f.resolve("D", "제71조");
    const followup = await p;
    expect(names(followup)).toContain("개인정보 보호법 시행령 제70조");
    expect(names(followup)).toContain("개인정보 보호법 시행령 제71조");
  });

  it("breaks before a phase-2 chunk once the budget is expired", async () => {
    const f = deferredSources({ tocCount: 8, citing: new Set(["제61조", "제63조", "제76조", "제77조", "제78조", "제79조", "제70조", "제71조"]) });
    let clock = 0;
    const p = retrieveResearchFollowup("law_system", QUERY, "", undefined, f.sources, [], () => clock);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    await waitFor(() => f.calls.includes("D/제63조"), "phase-1 pair 1");
    f.resolve("D", "제61조");
    f.resolve("D", "제63조");
    await waitFor(() => f.calls.includes("D/제77조"), "phase-1 pair 2");
    f.resolve("D", "제76조");
    f.resolve("D", "제77조");
    await waitFor(() => f.calls.includes("D/제79조"), "phase-1 pair 3");
    clock = 16000; // expired before phase-2 starts
    f.resolve("D", "제78조");
    f.resolve("D", "제79조");
    const followup = await p;
    expect(f.calls.filter((c) => c === "D/제70조" || c === "D/제71조")).toEqual([]);
    expect(names(followup)).not.toContain("개인정보 보호법 시행령 제70조");
    expect(followup.report.limited).toBe(true);
  });

  it("admits exactly one slot of a pair at 17 keys", async () => {
    const f = deferredSources({ tocCount: 18, citing: new Set(["제45조"]) });
    const p = retrieveResearchFollowup("law_system", QUERY, "", undefined, f.sources, [], () => 0);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    // Drive every pair in order; the last pair is (제45조, 제46조) at 17 keys.
    // The final slot is refused, so it is never waited on — only asserted absent.
    const tierOrder = TOC_TITLES.map((e) => e.jo);
    for (const jo of tierOrder.slice(0, 17)) {
      await waitFor(() => f.calls.includes(`D/${jo}`), `tier call ${jo}`);
      if (f.pending.has(`D/${jo}`)) f.resolve("D", jo);
    }
    const followup = await p;
    expect(f.calls).toContain("D/제45조");
    expect(f.calls).not.toContain("D/제46조");
    expect(names(followup)).toContain("개인정보 보호법 시행령 제45조");
    expect(followup.report.limited).toBe(true);
  });

  it("keeps other modes sequential", async () => {
    // Same 4 scoring candidates as the law_system pair test: 제61조, 제63조, 제76조, 제77조.
    const f = deferredSources({ tocCount: 4, citing: new Set(["제61조", "제63조"]) });
    const p = retrieveResearchFollowup("action_basis", QUERY, "", undefined, f.sources, [], () => 0);
    await waitFor(() => f.calls.includes("P/제38조"), "parent call");
    f.resolve("P", "제38조");
    await waitFor(() => f.calls.includes("D/제61조"), "first tier call");
    await flush(20);
    // While the first tier read is pending, no second read starts.
    expect(f.calls.filter((c) => c.startsWith("D/"))).toEqual(["D/제61조"]);
    f.resolve("D", "제61조");
    await waitFor(() => f.calls.includes("D/제63조"), "second tier call");
    f.resolve("D", "제63조");
    await waitFor(() => f.calls.includes("D/제76조"), "third tier call");
    f.resolve("D", "제76조");
    await waitFor(() => f.calls.includes("D/제77조"), "fourth tier call");
    f.resolve("D", "제77조");
    const followup = await p;
    expect(f.maxUnresolved()).toBe(1);
    expect(names(followup)).toEqual([
      "개인정보 보호법 제38조",
      "개인정보 보호법 시행령 제61조",
      "개인정보 보호법 시행령 제63조",
    ]);
  });
});
