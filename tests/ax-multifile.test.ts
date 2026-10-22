import { describe, expect, it } from "vitest";
import { MAX_TASK_ATTACHMENTS, attachmentFields, attachmentPatch, buildAttachmentSummary, combineAttachmentSummaries, taskAttachments, ATTACHMENT_TRUNCATION_NOTICE } from "../src/lib/ax/attachments";
import { AX_LIMITS, axTaskSchema } from "../src/lib/ax/schema";
import { exportAxState, importAxState } from "../src/lib/ax/transfer";
import { isRegistrationUnchanged } from "../src/lib/ax/registration";
import { emptyAxState, type AxAttachmentMeta, type AxTask } from "../src/lib/ax/types";

const meta = (name: string, fingerprint: string): AxAttachmentMeta => ({ name, type: "text/csv", size: 42, lastModified: 123, fingerprint });
const fp = (ch: string) => ch.repeat(64);
const base: AxTask = {
  id: "task-1", name: "월간 정산", description: "매월 정산", status: "registered",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("taskAttachments 정규화", () => {
  it("첨부가 없으면 빈 목록", () => {
    expect(taskAttachments(base)).toEqual([]);
  });
  it("단일 첨부 시절 데이터(attachmentMeta만 존재)를 1개 목록으로 읽는다", () => {
    expect(taskAttachments({ ...base, attachmentMeta: meta("a.csv", fp("a")) })).toEqual([meta("a.csv", fp("a"))]);
  });
  it("다중 첨부(attachmentMetas)가 있으면 그 목록이 기준이다", () => {
    const list = [meta("a.csv", fp("a")), meta("b.xlsx", fp("b"))];
    expect(taskAttachments({ ...base, attachmentMeta: list[0], attachmentMetas: list })).toEqual(list);
  });
});

describe("attachmentFields 저장 변환", () => {
  it("빈 목록이면 두 필드 모두 없음", () => {
    expect(attachmentFields([])).toEqual({});
    expect(attachmentPatch([])).toEqual({ attachmentMeta: undefined, attachmentMetas: undefined });
  });
  it("1개면 대표 메타데이터만 기록해 기존 단일 첨부 표현과 같다", () => {
    expect(attachmentFields([meta("a.csv", fp("a"))])).toEqual({ attachmentMeta: meta("a.csv", fp("a")) });
  });
  it("2개 이상이면 전체 목록과 대표 메타데이터를 함께 기록한다", () => {
    const list = [meta("a.csv", fp("a")), meta("b.xlsx", fp("b"))];
    expect(attachmentFields(list)).toEqual({ attachmentMeta: list[0], attachmentMetas: list });
  });
  it("최대 개수는 10개다", () => {
    expect(MAX_TASK_ATTACHMENTS).toBe(10);
  });
});

describe("스키마·전송 호환성", () => {
  it("attachmentMetas는 최대 10개까지 허용하고 11개는 거부한다", () => {
    const ten = Array.from({ length: 10 }, (_, i) => meta(`f${i}.csv`, fp(String(i % 10))));
    expect(axTaskSchema.safeParse({ ...base, attachmentMetas: ten }).success).toBe(true);
    expect(axTaskSchema.safeParse({ ...base, attachmentMetas: [...ten, meta("extra.csv", fp("e"))] }).success).toBe(false);
  });
  it("잘못된 지문을 가진 다중 첨부는 거부한다", () => {
    expect(axTaskSchema.safeParse({ ...base, attachmentMetas: [{ ...meta("a.csv", fp("a")), fingerprint: "xyz" }] }).success).toBe(false);
  });
  it("기존 단일 첨부 상태가 내보내기·가져오기를 그대로 왕복한다", () => {
    const state = { ...emptyAxState(), tasks: [{ ...base, attachmentMeta: meta("legacy.csv", fp("a")) }], selectedTaskId: "task-1", step: 1 as const };
    expect(importAxState(exportAxState(state))).toEqual(state);
  });
  it("다중 첨부 상태가 내보내기·가져오기를 그대로 왕복하고 요약·원본은 포함되지 않는다", () => {
    const list = [meta("a.csv", fp("a")), meta("b.pdf", fp("b")), meta("c.xlsx", fp("c"))];
    const state = { ...emptyAxState(), tasks: [{ ...base, ...attachmentFields(list) }], selectedTaskId: "task-1", step: 1 as const };
    const json = exportAxState(state);
    expect(importAxState(json)).toEqual(state);
    expect(json).not.toContain("attachmentSummary");
    expect(json).not.toContain("bytes");
  });
});

describe("등록 변경 감지 (단일·다중 표현 호환)", () => {
  it("같은 파일이 단일 표현과 다중 표현으로 달라도 변경 없음으로 본다", () => {
    const legacy: AxTask = { ...base, attachmentMeta: meta("a.csv", fp("a")) };
    const modern: AxTask = axTaskSchema.parse({ ...base, ...attachmentFields([meta("a.csv", fp("a"))]) });
    expect(isRegistrationUnchanged(legacy, modern)).toBe(true);
  });
  it("다중 목록에 파일을 추가·제거하면 변경으로 감지한다", () => {
    const two: AxTask = axTaskSchema.parse({ ...base, ...attachmentFields([meta("a.csv", fp("a")), meta("b.csv", fp("b"))]) });
    const three: AxTask = axTaskSchema.parse({ ...base, ...attachmentFields([meta("a.csv", fp("a")), meta("b.csv", fp("b")), meta("c.csv", fp("c"))]) });
    const one: AxTask = axTaskSchema.parse({ ...base, ...attachmentFields([meta("a.csv", fp("a"))]) });
    expect(isRegistrationUnchanged(two, three)).toBe(false);
    expect(isRegistrationUnchanged(two, one)).toBe(false);
    expect(isRegistrationUnchanged(two, axTaskSchema.parse({ ...two }))).toBe(true);
  });
});

describe("buildAttachmentSummary (기존 단일 파일 형식 유지)", () => {
  it("기존 형식 그대로 생성한다", () => {
    const summary = buildAttachmentSummary("csv", { paragraphCount: 3, tableCount: 1 }, [{ text: "단서1" }, { text: "단서2" }]);
    expect(summary).toBe("문서 유형: csv\n구조: 문단 3개, 표 1개\n주요 업무 단서: 단서1\n주요 업무 단서: 단서2");
  });
  it("단서는 최대 8개·180자로 제한하고 전체는 첨부 요약 한도를 넘지 않는다", () => {
    const topics = Array.from({ length: 20 }, (_, i) => ({ text: `단서${i} ` + "x".repeat(300) }));
    const summary = buildAttachmentSummary("pdf", { paragraphCount: 1, tableCount: 0 }, topics);
    expect(summary.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
    expect(summary.match(/주요 업무 단서:/g)).toHaveLength(8);
  });
});

describe("combineAttachmentSummaries (통합 요약)", () => {
  it("파일이 없으면 undefined", () => {
    expect(combineAttachmentSummaries([])).toBeUndefined();
  });
  it("파일이 1개면 요약을 그대로 반환한다 (기존 진단 입력과 바이트 동일)", () => {
    const summary = buildAttachmentSummary("csv", { paragraphCount: 2, tableCount: 1 }, [{ text: "단서" }]);
    expect(combineAttachmentSummaries([{ name: "a.csv", summary }])).toBe(summary);
  });
  it("여러 파일은 출처 헤더로 구분하고 파일별 내용을 유지한다", () => {
    const combined = combineAttachmentSummaries([
      { name: "입력.csv", summary: "문서 유형: csv\n구조: 문단 2개, 표 1개\n주요 업무 단서: 입력 단서" },
      { name: "보고서.xlsx", summary: "문서 유형: xlsx\n구조: 문단 5개, 표 3개\n주요 업무 단서: 출력 단서" },
    ])!;
    expect(combined).toContain("[첨부 파일 1: 입력.csv]");
    expect(combined).toContain("[첨부 파일 2: 보고서.xlsx]");
    expect(combined).toContain("입력 단서");
    expect(combined).toContain("출력 단서");
    expect(combined.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
  });
  it("여러 파일에 완전히 동일한 단서 줄은 한 번만 남긴다", () => {
    const combined = combineAttachmentSummaries([
      { name: "a.csv", summary: "문서 유형: csv\n주요 업무 단서: 같은 단서" },
      { name: "b.csv", summary: "문서 유형: csv\n주요 업무 단서: 같은 단서" },
    ])!;
    expect(combined.match(/같은 단서/g)).toHaveLength(1);
    // 구조 줄(문서 유형)은 파일별로 유지된다
    expect(combined.match(/문서 유형: csv/g)).toHaveLength(2);
  });
  it("길이 제한을 넘으면 축약 사실을 고지하고 제한 안에 들어간다", () => {
    const longSummary = (label: string) => [`문서 유형: csv`, ...Array.from({ length: 8 }, (_, i) => `주요 업무 단서: ${label} 단서 ${i} ${"y".repeat(150)}`)].join("\n");
    const combined = combineAttachmentSummaries([
      { name: "a.csv", summary: longSummary("a") },
      { name: "b.csv", summary: longSummary("b") },
      { name: "c.csv", summary: longSummary("c") },
    ])!;
    expect(combined.length).toBeLessThanOrEqual(AX_LIMITS.attachmentSummary);
    expect(combined).toContain(ATTACHMENT_TRUNCATION_NOTICE);
    expect(combined).toContain("[첨부 파일 1: a.csv]");
    expect(combined).toContain("[첨부 파일 3: c.csv]");
  });
});
