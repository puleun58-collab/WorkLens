import type { BriefPresentationMode } from "@/domain/ai";

const REPORT_PATTERN = /(보고서|보고\s*형식|업무\s*보고)/u;
const SECTION_PATTERN = /(항목별|항목\s*별|주제별|구획)/u;
const ACTION_PATTERN = /(결론.*액션|액션\s*아이템|후속\s*조치\s*중심)/u;
const LINE_PATTERN = /(?:핵심(?:만)?\s*)?(?:최대\s*)?5\s*줄/u;
const FORMAT_ONLY_PATTERN = /(보고서|보고\s*형식|항목별|항목\s*별|주제별|구획|결론|액션\s*아이템|후속\s*조치|임원\s*보고|간결|간단|짧게|핵심(?:만)?|\d+\s*줄)/gu;

export function briefPresentationMode(instruction: string | undefined): BriefPresentationMode {
  const value = instruction?.normalize("NFKC").trim() ?? "";
  if (ACTION_PATTERN.test(value)) return "actions";
  if (REPORT_PATTERN.test(value)) return "report";
  if (SECTION_PATTERN.test(value)) return "sections";
  if (LINE_PATTERN.test(value)) return "lines";
  return "bullets";
}

export interface BriefScope {
  minimumPage?: number;
  /** An explicit "~만" restriction: evidence outside it is dropped. */
  focus?: string;
  /** A plain emphasis: evidence is reordered, never removed. */
  emphasis?: string;
}

/** Only explicit location/topic restrictions affect evidence selection. */
export function briefScope(instruction: string | undefined): BriefScope {
  const value = instruction?.normalize("NFKC").trim() ?? "";
  if (!value) return {};

  const pageMatch = /(\d+)\s*(?:페이지|쪽|슬라이드)\s*(?:이후|부터)(?:의?\s*내용)?(?:만)?/u.exec(value);
  const minimumPage = pageMatch ? Number(pageMatch[1]) : undefined;

  const withoutPage = value.replace(/\d+\s*(?:페이지|쪽|슬라이드)\s*(?:이후|부터)(?:의?\s*내용)?(?:만)?/gu, " ");
  const withoutFormat = withoutPage.replace(FORMAT_ONLY_PATTERN, " ").replace(/[\/,+]/gu, " ").replace(/\s+/gu, " ").trim();
  const explicitTopic = /(?:관련(?:된)?\s*(?:내용)?\s*만|(?:내용|부분)\s*만)/u.test(value);
  const topic = withoutFormat
    .replace(/(?:관련(?:된)?|내용|부분|중심|만|요약|정리|해줘|해주세요)/gu, " ")
    .split(/\s+/u)
    // Particles left behind by a formatting phrase are not a topic.
    .filter((token) => token && !/^(?:용으로|으로|로서|로|에서|에게|에|의|은|는|이|가|을|를|과|와|및|등)$/u.test(token))
    .join(" ")
    .trim();
  // "Actual 중심" asks for a lens on the whole document, not a smaller
  // document: it reorders evidence instead of removing the rest.
  const focus = explicitTopic ? topic : "";
  const emphasis = explicitTopic ? "" : topic;

  return {
    ...(Number.isInteger(minimumPage) && minimumPage! > 0 ? { minimumPage } : {}),
    ...(focus.length >= 2 ? { focus } : {}),
    ...(emphasis.length >= 2 ? { emphasis } : {}),
  };
}
