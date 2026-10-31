import { describe, expect, it } from "vitest";
import { VERIFICATION_CONTRACTS, verificationContractById } from "@/lib/ax/verification-contracts";

describe("P2 업무 유형별 검증 계약", () => {
  it("10유형이 고정 id·이름·2~4개 계약 문장으로 구성된다", () => {
    expect(VERIFICATION_CONTRACTS.map(c => c.id)).toEqual([
      "data-processing", "web-ui", "crud", "api", "permissions",
      "approval-workflow", "browser-automation", "document-processing",
      "notification-delivery", "schedule-dashboard",
    ]);
    expect(VERIFICATION_CONTRACTS.map(c => c.name)).toEqual([
      "데이터 처리", "웹 UI", "CRUD", "API", "권한 관리",
      "승인 워크플로", "브라우저 자동화", "문서 처리",
      "알림·전송", "일정·대시보드",
    ]);
    expect(new Set(VERIFICATION_CONTRACTS.map(c => c.id)).size).toBe(10);
    for (const contract of VERIFICATION_CONTRACTS) {
      expect(contract.contracts.length).toBeGreaterThanOrEqual(2);
      expect(contract.contracts.length).toBeLessThanOrEqual(4);
      for (const sentence of contract.contracts) expect(sentence.trim().length).toBeGreaterThan(0);
      expect(contract.p4Scenarios.length).toBeGreaterThan(0);
    }
  });

  it("P4 시나리오 매핑이 S01~S12를 모두 한 번 이상 덮는다", () => {
    const covered = new Set(VERIFICATION_CONTRACTS.flatMap(c => c.p4Scenarios));
    for (const scenario of ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12"]) {
      expect(covered.has(scenario)).toBe(true);
    }
    expect(verificationContractById("crud")?.name).toBe("CRUD");
    expect(verificationContractById("unknown")).toBeUndefined();
  });
});
