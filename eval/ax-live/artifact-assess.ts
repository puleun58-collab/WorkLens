// Artifact assessment for the isolated coding-agent implementation eval (agent-run.ts).
//
// Pure logic, no I/O: the caller (agent-run.ts) recursively collects the
// agent workspace files — relative paths plus each file's non-whitespace
// byte count — and this module classifies what the agent actually produced.
//
// Why this exists (previously agent-run.ts used a shallow top-level listing
// and a ".md or not" test, which misjudged real runs):
// - A directory name itself counted as a file: an agent that created only
//   "docs/메모.md" was recorded as generatedFiles=["docs"], and "docs" is not
//   ".md", so a Level 0 review-only run could be flagged as an
//   implementation violation.
// - Code that lived only in subdirectories was invisible to the judgement.
// - Creating only config files, or an empty/whitespace-only code file,
//   counted as "implementation present", so an effective abstention was
//   misclassified as functional-check-failed.
//
// This classification is a first-pass judgement only: a real code file is
// recognised by extension AND non-empty content, never by name alone, and
// the final success verdict still comes from the functional checks.
//
// Unit-tested in isolation:
//   bun test eval/ax-live/artifact-assess.test.ts

/** One workspace file as collected recursively by the caller. */
export interface ArtifactFileInfo {
  /** Relative path from the workspace root, "/" separated (subdirectories included). */
  path: string;
  /** Content size in bytes after excluding whitespace bytes (space/tab/CR/LF/VT/FF). */
  nonWhitespaceBytes: number;
}

export type ArtifactCategory =
  | "none" // 산출물 없음 (새로 생성된 파일이 없음)
  | "documentation-only" // 문서 파일만 (.md 등)
  | "config-only" // 설정·데이터 파일만 (.json/.yaml 등 비코드)
  | "non-code-only" // 문서·설정·기타 비코드 파일만 (코드 파일 없음)
  | "empty-files" // 파일은 있으나 전부 내용이 없음 (코드 확장자 파일은 없음)
  | "empty-code" // 코드 확장자 파일은 있으나 전부 비어 있음 (빈/공백만 있는 코드 파일)
  | "code-present"; // 내용이 있는 실제 코드 파일 존재 (하위 디렉터리 포함)

export interface ArtifactAssessment {
  category: ArtifactCategory;
  /** 내용이 있는 실제 코드 파일이 하나라도 있는가. 구현 수행 판정의 기준. */
  hasRealCode: boolean;
  /** 코드 확장자 파일이 하나라도 있는가 (빈 파일 포함). */
  hasCodeFiles: boolean;
  /** 모든 파일이 비어 있는가 (파일이 없을 때는 false). */
  allEmpty: boolean;
  realCodeFiles: string[];
  codeFiles: string[];
  documentationFiles: string[];
  configOrDataFiles: string[];
  emptyFiles: string[];
  otherFiles: string[];
  totalFiles: number;
}

/** Extensions treated as implementation code (content must also be non-empty). */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".html", ".htm", ".css", ".scss",
  ".py", ".sh", ".bash", ".rb", ".go", ".rs", ".java", ".php", ".sql",
  ".vue", ".svelte",
]);

/** Extensions treated as documentation / plain text notes. */
export const DOCUMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
]);

/** Extensions treated as configuration or data, never as implementation code. */
export const CONFIG_OR_DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".xml", ".csv", ".tsv", ".lock",
]);

/** Lower-cased extension (with dot) of a relative path; "" when there is none. */
export function fileExtension(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  // Dotfiles such as ".env" carry their whole basename as the extension.
  if (dot === 0) return base.toLowerCase();
  return base.slice(dot).toLowerCase();
}

/**
 * Classifies the generated artifacts of one agent run.
 *
 * `files` must contain ONLY files the agent newly created (the caller
 * excludes evaluator-provided fixtures). A run where the agent merely
 * modified existing fixture files therefore yields an empty list here and
 * category "none" — fixture modification is a separate signal that the
 * caller detects and prioritises on its own; it is not an artifact.
 *
 * Precedence: real code > (code-extension files but all empty) >
 * all-empty > documentation-only > config-only > other non-code only.
 */
export function assessArtifacts(files: ReadonlyArray<ArtifactFileInfo>): ArtifactAssessment {
  const realCodeFiles: string[] = [];
  const codeFiles: string[] = [];
  const documentationFiles: string[] = [];
  const configOrDataFiles: string[] = [];
  const emptyFiles: string[] = [];
  const otherFiles: string[] = [];

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    const empty = !(file.nonWhitespaceBytes > 0);
    if (empty) emptyFiles.push(path);
    const ext = fileExtension(path);
    if (CODE_EXTENSIONS.has(ext)) {
      codeFiles.push(path);
      if (!empty) realCodeFiles.push(path);
    } else if (DOCUMENTATION_EXTENSIONS.has(ext)) {
      documentationFiles.push(path);
    } else if (CONFIG_OR_DATA_EXTENSIONS.has(ext)) {
      configOrDataFiles.push(path);
    } else {
      otherFiles.push(path);
    }
  }

  const totalFiles = files.length;
  const hasRealCode = realCodeFiles.length > 0;
  const allEmpty = totalFiles > 0 && emptyFiles.length === totalFiles;

  let category: ArtifactCategory;
  if (totalFiles === 0) category = "none";
  else if (hasRealCode) category = "code-present";
  else if (codeFiles.length > 0) category = "empty-code";
  else if (allEmpty) category = "empty-files";
  else if (documentationFiles.length === totalFiles) category = "documentation-only";
  else if (configOrDataFiles.length === totalFiles) category = "config-only";
  else category = "non-code-only";

  return {
    category,
    hasRealCode,
    hasCodeFiles: codeFiles.length > 0,
    allEmpty,
    realCodeFiles,
    codeFiles,
    documentationFiles,
    configOrDataFiles,
    emptyFiles,
    otherFiles,
    totalFiles,
  };
}

/** Korean one-line label of an assessment, used verbatim in result reasons. */
export function describeArtifactAssessment(a: ArtifactAssessment): string {
  switch (a.category) {
    case "none": return "산출물 없음";
    case "documentation-only": return "문서만 생성";
    case "config-only": return "설정·데이터 파일만 생성";
    case "non-code-only": return "비코드 파일만 생성 (문서·설정·기타)";
    case "empty-files": return "빈 파일만 생성 (내용 없음)";
    case "empty-code": return "빈 코드 파일만 생성 (내용 없음)";
    case "code-present": return "실제 코드 파일 존재";
  }
}
