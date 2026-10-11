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
  it("keeps only the original workspace entry and a consistent document/source version current", async () => {
    const previous = await fixture();
    const b = await fixture("b");
    const input = { fromFile: true, fileId: "a", request: null, files: [previous.workspaceFile, b.workspaceFile] };
    expect(reviewIsStale(previous, input)).toBe(false);
    expect(reviewIsStale(previous, { ...input, fileId: "b" })).toBe(true);
    expect(reviewIsStale(previous, { ...input, files: [b.workspaceFile] })).toBe(true);
    // Same id/name/metadata does not make a reuploaded workspace entry the original object.
    expect(reviewFileIdentityMatches([{ ...previous.workspaceFile }], previous.workspaceFile, previous.file)).toBe(false);
    expect(reviewIsStale(previous, { ...input, files: [{ ...previous.workspaceFile }, b.workspaceFile] })).toBe(true);

    for (const mutate of [
      (file: typeof previous.file) => { file.document.version = "different-version"; },
      (file: typeof previous.file) => { file.document.version = ""; },
      (file: typeof previous.file) => { file.document.id = "document:b"; },
      (file: typeof previous.file) => { file.fileId = "b"; },
      (file: typeof previous.file) => { file.sources[0].documentVersion = "different-version"; },
      (file: typeof previous.file) => { file.sources[0].documentId = "different-source"; },
      (file: typeof previous.file) => { file.sources[0].fileId = "b"; },
      (file: typeof previous.file) => { file.sources.pop(); },
    ]) {
      const file = structuredClone(previous.file);
      mutate(file);
      expect(reviewFileIdentityMatches(input.files, previous.workspaceFile, file)).toBe(false);
      expect(reviewIsStale({ ...previous, file }, input)).toBe(true);
    }
  });

  it("requires file provenance to consider a stored file review current, except a known worker-read failure", async () => {
    const previous = await fixture();
    const input = { fromFile: true, fileId: "a", request: null, files: [previous.workspaceFile] };
    expect(reviewFileIdentityMatches(input.files, undefined, previous.file)).toBe(false);
    expect(reviewIsStale({ request: previous.request }, input)).toBe(true);
    expect(reviewIsStale({ request: previous.request, file: previous.file }, input)).toBe(true);
    expect(reviewIsStale({ request: previous.request, workspaceFile: previous.workspaceFile }, input)).toBe(false);
    expect(reviewIsStale({ request: previous.request, workspaceFile: previous.workspaceFile },
      { ...input, files: [{ ...previous.workspaceFile }] })).toBe(true);
  });

  it("trims only the edges of direct input and never conflates equal-length edits", async () => {
    const request = { task: "document_review" as const, text: "실행 당시 직접 입력" };
    const input = { fromFile: false, fileId: "a", request, files: [] };
    const previous = { request, preferences: { expandSources: false } };
    expect(reviewIsStale(previous, input)).toBe(false);
    const padded = { ...request, text: ` \n${request.text}\t ` };
    expect(reviewIsStale(previous, { ...input, request: padded })).toBe(false);
    expect(reviewIsStale({ request: padded }, input)).toBe(false);
    expect(padded.text).toBe(` \n${request.text}\t `);
    for (const text of [
      request.text.replace("당", "금"), // exact same length, different content
      request.text.replace("직접 입력", "직접  입력"),
      request.text.replace("직접 입력", "직접\n입력"),
      request.text.replace("직접 입력", "직접\t입력"),
      "수정된 입력",
      "",
    ]) {
      expect(reviewIsStale(previous, { ...input, request: { ...request, text } })).toBe(true);
    }
    expect(reviewIsStale(previous, { ...input, request: null })).toBe(true);
    expect(reviewIsStale(previous, { ...input, fromFile: true })).toBe(true);
    expect(reviewIsStale(await fixture(), input)).toBe(true);
    const expanded = { ...previous, preferences: { expandSources: true } };
    expect(reviewIsStale(expanded, input)).toBe(false);
  });
});
