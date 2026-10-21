// Isolated unit tests for the artifact assessment (artifact-assess.ts).
// Pure logic: every case feeds synthetic { path, nonWhitespaceBytes } entries
// (exactly what agent-run.ts records from its recursive workspace collection)
// into assessArtifacts() and asserts the classification. No agent is executed
// and no filesystem is touched.
//
// Run: bun test eval/ax-live/artifact-assess.test.ts
import { describe, expect, test } from "bun:test";
import { assessArtifacts, describeArtifactAssessment, type ArtifactFileInfo } from "./artifact-assess";

const f = (path: string, nonWhitespaceBytes: number): ArtifactFileInfo => ({ path, nonWhitespaceBytes });

describe("assessArtifacts: 산출물 분류", () => {
  test("산출물 없음 → none, 실제 코드 없음", () => {
    const a = assessArtifacts([]);
    expect(a.category).toBe("none");
    expect(a.hasRealCode).toBe(false);
    expect(a.totalFiles).toBe(0);
    expect(describeArtifactAssessment(a)).toBe("산출물 없음");
  });

  test(".md 파일만 → documentation-only (구현 아님)", () => {
    const a = assessArtifacts([f("notes.md", 120)]);
    expect(a.category).toBe("documentation-only");
    expect(a.hasRealCode).toBe(false);
    expect(a.documentationFiles).toEqual(["notes.md"]);
  });

  test("하위 폴더의 .md만 → documentation-only (디렉터리명이 파일로 오판되지 않음)", () => {
    // 수정 전 결함: 최상위만 나열해 generatedFiles=["docs"]가 되었고, "docs"는
    // .md가 아니라는 이유로 Level 0에서 구현 위반으로 오판될 수 있었다.
    const a = assessArtifacts([f("docs/메모.md", 80)]);
    expect(a.category).toBe("documentation-only");
    expect(a.hasRealCode).toBe(false);
    expect(a.realCodeFiles).toEqual([]);
  });

  test("package.json만 → config-only (설정 파일만으로는 구현 아님)", () => {
    const a = assessArtifacts([f("package.json", 90)]);
    expect(a.category).toBe("config-only");
    expect(a.hasRealCode).toBe(false);
    expect(a.configOrDataFiles).toEqual(["package.json"]);
  });

  test("설정·데이터 파일만 (하위 폴더 포함) → config-only", () => {
    const a = assessArtifacts([f("config/settings.yaml", 40), f("data.json", 25)]);
    expect(a.category).toBe("config-only");
    expect(a.hasRealCode).toBe(false);
  });

  test("문서+설정 혼합 (코드 없음) → non-code-only", () => {
    const a = assessArtifacts([f("README.md", 50), f("package.json", 90)]);
    expect(a.category).toBe("non-code-only");
    expect(a.hasRealCode).toBe(false);
  });

  test("빈 main.mjs (0바이트) → empty-code (구현 있음으로 취급하지 않음)", () => {
    // 수정 전 결함: 빈 코드 파일도 ".md가 아닌 파일"이라는 이유로 구현으로
    // 취급되어 functional-check-failed로 분류됐다.
    const a = assessArtifacts([f("main.mjs", 0)]);
    expect(a.category).toBe("empty-code");
    expect(a.hasCodeFiles).toBe(true);
    expect(a.hasRealCode).toBe(false);
    expect(a.emptyFiles).toEqual(["main.mjs"]);
  });

  test("공백만 있는 파일 → 내용 없음으로 분류 (공백 제외 바이트 수 0)", () => {
    // 호출자(agent-run.ts)는 공백 바이트를 제외하고 크기를 기록하므로,
    // 공백만 있는 파일은 nonWhitespaceBytes=0 으로 들어온다.
    const code = assessArtifacts([f("src/main.mjs", 0)]);
    expect(code.category).toBe("empty-code");
    expect(code.hasRealCode).toBe(false);
    const docs = assessArtifacts([f("notes.md", 0)]);
    expect(docs.category).toBe("empty-files");
    expect(docs.hasRealCode).toBe(false);
  });

  test("문서가 있어도 빈 코드 파일만 있으면 empty-code", () => {
    const a = assessArtifacts([f("notes.md", 60), f("main.mjs", 0)]);
    expect(a.category).toBe("empty-code");
    expect(a.hasRealCode).toBe(false);
  });

  test("하위 폴더의 실제 코드 → code-present (재귀 수집으로만 보이는 경우)", () => {
    // 수정 전 결함: 최상위만 나열해 하위 폴더에만 있는 구현을 놓쳤다.
    const a = assessArtifacts([f("src/server.mjs", 420), f("src/util/helpers.ts", 130)]);
    expect(a.category).toBe("code-present");
    expect(a.hasRealCode).toBe(true);
    expect(a.realCodeFiles).toEqual(["src/server.mjs", "src/util/helpers.ts"]);
  });

  test("루트 실제 코드 + 문서/설정 혼합 → code-present", () => {
    const a = assessArtifacts([f("main.mjs", 300), f("notes.md", 50), f("local-state.json", 20)]);
    expect(a.category).toBe("code-present");
    expect(a.hasRealCode).toBe(true);
    expect(a.realCodeFiles).toEqual(["main.mjs"]);
  });

  test("내용 있는 HTML도 코드로 판정한다 (파일명·확장자만으로 성공 판정은 아님 — 최종 성공은 기능 검사)", () => {
    const a = assessArtifacts([f("index.html", 200)]);
    expect(a.category).toBe("code-present");
    expect(a.hasRealCode).toBe(true);
  });

  test("기존 파일 수정만 있는 경우 → 새 산출물 목록은 비어 none (fixture 변경은 호출자가 별도 감지·우선 판정)", () => {
    // 하네스 구조상 assessArtifacts 입력은 '새로 생성된 파일'뿐이다. 에이전트가
    // 기존 fixture만 수정한 실행은 입력 목록이 비어 none 이 되며, 그 실행의
    // 판정은 fixture-modified 감지(기존 방식)가 산출물 분류보다 우선한다.
    const a = assessArtifacts([]);
    expect(a.category).toBe("none");
    expect(a.hasRealCode).toBe(false);
  });

  test("확장자 없는 내용 있는 파일은 코드로 단정하지 않는다 (other → non-code-only)", () => {
    const a = assessArtifacts([f("output", 100)]);
    expect(a.category).toBe("non-code-only");
    expect(a.hasRealCode).toBe(false);
    expect(a.otherFiles).toEqual(["output"]);
  });
});
