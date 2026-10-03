import type { WorkspaceFile } from "@/client/protocol";
import type { ReviewFile } from "@/lib/law-review-source";
import type { LawResearchRequest } from "@/lib/law-research";

/** Workspace entries are immutable; replacement entries cannot inherit old results. */
export function reviewFileIdentityMatches(files: readonly WorkspaceFile[], workspaceFile?: WorkspaceFile, file?: ReviewFile): boolean {
  if (!workspaceFile || files.find((entry) => entry.id === workspaceFile.id) !== workspaceFile) return false;
  if (!file) return true; // A worker read failure still retains the original workspace entry.
  return file.fileId === workspaceFile.id && file.document.id === `document:${workspaceFile.id}`
    && Boolean(file.document.version) && file.sources.length === file.document.segments.length
    && file.sources.every((source) => source.fileId === workspaceFile.id
      && source.documentId === file.document.id && source.documentVersion === file.document.version);
}

export function reviewIsStale(
  previous: { request: LawResearchRequest; workspaceFile?: WorkspaceFile; file?: ReviewFile },
  input: { fromFile: boolean; fileId: string; request: LawResearchRequest | null; files: readonly WorkspaceFile[] },
): boolean {
  if (previous.workspaceFile || previous.file) {
    return !input.fromFile || input.fileId !== previous.workspaceFile?.id
      || !reviewFileIdentityMatches(input.files, previous.workspaceFile, previous.file);
  }
  return input.fromFile || !("text" in previous.request) || !input.request
    || !("text" in input.request) || previous.request.text !== input.request.text;
}
