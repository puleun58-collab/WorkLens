import { describe, expect, it } from "vitest";
import { reviewFileIdentityMatches, reviewIsStale } from "@/client/review-provenance";
import { parseDocument } from "@/lib/parsers";
import { reviewFileFor, reviewRequestFor } from "@/lib/law-review-source";
import type { WorkspaceFile } from "@/client/protocol";
import { createDocxParagraphs } from "./fixtures";

async function fixture(id = "a") {
  const document = await parseDocument({ fileId: id, fileName: "계약서.docx", bytes: createDocxParagraphs(["용역 계약서", "당사자는 조건을 협의하여 업무를 진행한다."]) });
  const workspaceFile: WorkspaceFile = { id, name: "계약서.docx", kind: "docx", size: 1, status: "ready", metadata: document.metadata, warnings: [] };
  const file = reviewFileFor(document, workspaceFile.name);
  return { workspaceFile, file, request: reviewRequestFor(file.document) };
}

describe("review provenance identity", () => {
  it("selection, deletion, same-name reupload and source/version mismatches invalidate the original identity", async () => {
    const previous = await fixture();
    const b = await fixture("b");
    const input = { fromFile: true, fileId: "a", request: null, files: [previous.workspaceFile, b.workspaceFile] };
    expect(reviewIsStale(previous, input)).toBe(false);
    expect(reviewIsStale(previous, { ...input, fileId: "b" })).toBe(true);
    expect(reviewIsStale(previous, { ...input, files: [b.workspaceFile] })).toBe(true);
    expect(reviewFileIdentityMatches([{ ...previous.workspaceFile }], previous.workspaceFile, previous.file)).toBe(false);
    const changed = structuredClone(previous.file);
    changed.document.version = "different-version";
    expect(reviewFileIdentityMatches(input.files, previous.workspaceFile, changed)).toBe(false);
    changed.document.version = previous.file.document.version;
    changed.sources[0].documentId = "different-source";
    expect(reviewFileIdentityMatches(input.files, previous.workspaceFile, changed)).toBe(false);
  });

  it("direct edits and both mode transitions are stale; presentation is independent of identity", async () => {
    const request = { task: "document_review" as const, text: "실행 당시 직접 입력" };
    const input = { fromFile: false, fileId: "a", request, files: [] };
    const previous = { request, preferences: { expandSources: false } };
    expect(reviewIsStale(previous, input)).toBe(false);
    const padded = { ...request, text: ` \n${request.text}\t ` };
    expect(reviewIsStale(previous, { ...input, request: padded })).toBe(false);
    expect(reviewIsStale({ request: padded }, input)).toBe(false);
    expect(padded.text).toBe(` \n${request.text}\t `);
    expect(reviewIsStale(previous, { ...input, request: { ...request, text: request.text.replace("직접 입력", "직접  입력") } })).toBe(true);
    expect(reviewIsStale(previous, { ...input, request: { ...request, text: request.text.replace("직접 입력", "직접\n입력") } })).toBe(true);
    const expanded = { ...previous, preferences: { expandSources: true } };
    expect(reviewIsStale(expanded, input)).toBe(false);
    expect(reviewIsStale(previous, { ...input, request: { ...request, text: "수정된 입력" } })).toBe(true);
    expect(reviewIsStale(previous, { ...input, request: null })).toBe(true);
    expect(reviewIsStale(previous, { ...input, fromFile: true })).toBe(true);
    expect(reviewIsStale(await fixture(), input)).toBe(true);
  });
});
