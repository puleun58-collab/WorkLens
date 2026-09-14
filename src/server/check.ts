import type { NormalizedDocument, SourceRef, TableBlock, TableCell } from "@/domain/document";
import { parseCanonicalNumber } from "@/domain/numeric";
import type {
  CheckCategory,
  CheckCode,
  CheckFinding,
  CheckResult,
  CheckSeverity,
  ExplicitTotal,
} from "@/domain/operations";
const TOTAL_LABEL = /^(?:(?:grand\s+)?total\b|합계|총계)/iu;
const MAX_FINDINGS = 500;
const PLACEHOLDER = /\b(?:lorem\s+ipsum|TBD|TODO|XXX|FIXME|PLACEHOLDER)\b|(?:추후|향후)\s*(?:입력|작성|확정)|내용\s*(?:입력|작성)/iu;
const INTERNAL_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^\s/]+\.(?:internal|local))(?::\d+)?(?:\/[^\s]*)?/iu;
const SECRET = /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})["']?|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:\+?\d{1,3}[ .-])?(?:\(?\d{2,4}\)?[ .-])\d{3,4}[ .-]\d{4}\b/u;
const RESIDENT_REGISTRATION = /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/u;
const ACCOUNT_NUMBER = /(?:계좌(?:번호)?|account)\s*[:：]?\s*(\d{2,6}(?:[- ]\d{2,6}){2,5})/iu;
const EMPLOYEE_ID = /(?:사번|employee\s*id)\s*[:：#]?\s*([A-Z0-9][A-Z0-9_-]{3,11})\b/iu;
const SENSITIVE_ID = /\b\d{3}-\d{2}-\d{5}\b/u;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u;

interface TextUnit {
  text: string;
  source: SourceRef;
  blockId: string;
  kind: "paragraph" | "cell";
  headingLevel?: number;
  page?: number;
  row?: number;
  column?: number;
}

interface FindingInput {
  code: CheckCode;
  category: CheckCategory;
  severity: CheckSeverity;
  issue: string;
  message: string;
  reason: string;
  recommendation: string;
  sources: SourceRef[];
  originalText?: string;
  suggestedText?: string;
}

interface DateOccurrence {
  raw: string;
  style: "dot" | "dash" | "slash" | "korean";
  year?: number;
  month: number;
  day: number;
  unit: TextUnit;
}

interface ReportingPeriod {
  raw: string;
  year: number;
  month: number;
  unit: TextUnit;
}

interface NumberOccurrence {
  label: string;
  value: number;
  raw: string;
  unitLabel: string;
  unit: TextUnit;
}

function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.fileId}\0${source.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeFinding(input: FindingInput): CheckFinding {
  const sources = uniqueSources(input.sources);
  const source = sources[0];
  if (!source) throw new Error("Check findings require source evidence.");
  const id = `check:${input.code}:${stableId(`${source.fileId}\0${source.nodeId}\0${input.originalText ?? input.message}\0${input.suggestedText ?? ""}`)}`;
  return { id, ...input, source, sources };
}

function textOf(cell: TableCell): string {
  return cell.display.trim() || (cell.value === null ? "" : String(cell.value).trim());
}

function isEmpty(cell: TableCell): boolean {
  return cell.display.trim() === "" && (cell.value === null || (typeof cell.value === "string" && cell.value.trim() === ""));
}

function numericValue(cell: TableCell): number | undefined {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) return cell.value;
  return parseCanonicalNumber(textOf(cell))?.value;
}

function collectTextUnits(document: NormalizedDocument): TextUnit[] {
  const units: TextUnit[] = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      const text = block.text.trim();
      if (text) units.push({
        text,
        source: block.source,
        blockId: block.id,
        kind: "paragraph",
        ...(block.headingLevel ? { headingLevel: block.headingLevel } : {}),
        ...(block.source.page ? { page: block.source.page } : {}),
      });
      continue;
    }
    block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      const text = textOf(cell);
      if (text) units.push({
        text,
        source: cell.source,
        blockId: block.id,
        kind: "cell",
        row: rowIndex + 1,
        column: columnIndex + 1,
        ...(cell.source.page ? { page: cell.source.page } : {}),
      });
    }));
  }
  return units;
}

function privacyFindings(unit: TextUnit): CheckFinding[] {
  const { text, source } = unit;
  const findings: CheckFinding[] = [];
  const add = (
    code: CheckCode,
    severity: CheckSeverity,
    issue: string,
    match: string,
    recommendation: string,
  ) => findings.push(makeFinding({
    code,
    category: "privacy",
    severity,
    issue,
    message: `${issue}: ${match}`,
    reason: "문서 내용이 정의된 민감정보 패턴과 일치합니다.",
    recommendation,
    sources: [source],
    originalText: match,
  }));

  const secret = text.match(SECRET)?.[0];
  if (secret) add("privacy-secret", "critical", "인증정보 노출 가능성", secret, "즉시 토큰 또는 비밀번호를 폐기하고 문서에서 삭제하세요.");
  const resident = text.match(RESIDENT_REGISTRATION)?.[0];
  if (resident) add("privacy-resident-registration", "critical", "주민등록번호 형태", resident, "즉시 접근을 제한하고 식별번호를 삭제하거나 비식별화하세요.");
  const email = text.match(EMAIL)?.[0];
  if (email) add("privacy-email", "warning", "이메일 주소", email, "공유 범위를 확인하고 필요하면 이메일 주소를 마스킹하세요.");
  const phone = text.match(PHONE)?.[0];
  if (phone) add("privacy-phone", "warning", "전화번호", phone, "업무상 필요 여부를 확인하고 필요하면 전화번호를 마스킹하세요.");
  const account = text.match(ACCOUNT_NUMBER)?.[0];
  if (account) add("privacy-account-number", "warning", "계좌번호 가능성", account, "계좌번호가 필요한지 확인하고 외부 공유본에서는 마스킹하세요.");
  const employee = text.match(EMPLOYEE_ID)?.[0];
  if (employee) add("privacy-employee-id", "suggestion", "사번 가능성", employee, "사번이 개인 식별에 사용되는지 확인하고 필요하면 제거하세요.");
  const internalUrl = text.match(INTERNAL_URL)?.[0];
  if (internalUrl) add("privacy-internal-url", "warning", "내부 URL", internalUrl, "내부 주소를 제거하거나 외부 공개 가능한 주소로 교체하세요.");
  const ip = !internalUrl ? text.match(IPV4)?.[0] : undefined;
  if (ip) add("privacy-ip-address", "suggestion", "IP 주소", ip, "공유 범위를 확인하고 내부 시스템 주소라면 마스킹하세요.");
  const sensitiveId = text.match(SENSITIVE_ID)?.[0];
  if (sensitiveId) add("privacy-sensitive-id", "suggestion", "민감 식별번호 가능성", sensitiveId, "식별번호의 공개 필요성을 확인하고 필요하면 일부를 마스킹하세요.");
  return findings;
}

const KOREAN_CORRECTIONS: ReadonlyArray<[RegExp, string, string]> = [
  [/전먕/gu, "전망", "문맥상 명백한 오타 가능성"],
  [/됬/gu, "됐", "잘못된 한글 표기 가능성"],
  [/되여/gu, "되어", "잘못된 한글 표기 가능성"],
  [/적용\s+됩니다/gu, "적용됩니다", "서술어 띄어쓰기"],
  [/확인\s+해\s+주세요/gu, "확인해 주세요", "보조 용언 앞 띄어쓰기"],
];
const ENGLISH_CORRECTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bteh\b/giu, "the"],
  [/\brecieve\b/giu, "receive"],
  [/\boccured\b/giu, "occurred"],
  [/\bseperate\b/giu, "separate"],
  [/\baccomodate\b/giu, "accommodate"],
  [/\bdefinately\b/giu, "definitely"],
  [/\bforcast\b/giu, "forecast"],
];

function writingFindings(unit: TextUnit, kind: NormalizedDocument["kind"]): CheckFinding[] {
  if (!(["pptx", "docx", "pdf"] as const).includes(kind as "pptx" | "docx" | "pdf")) return [];
  const findings: CheckFinding[] = [];
  const add = (input: Omit<FindingInput, "sources">) => findings.push(makeFinding({ ...input, sources: [unit.source] }));
  const text = unit.text;

  const placeholder = text.match(PLACEHOLDER)?.[0];
  if (placeholder) add({
    code: "placeholder-text",
    category: "placeholder",
    severity: "warning",
    issue: "미정 또는 placeholder 문구",
    message: `제출 전 확정되지 않은 문구 "${placeholder}"가 남아 있습니다.`,
    reason: "미완성 표시는 최종 문서의 신뢰도를 낮추고 누락으로 이어질 수 있습니다.",
    recommendation: "내용을 확정해 교체하거나 해당 블록을 삭제하세요.",
    originalText: text,
  });

  const duplicateWord = /(^|[\s("'])((?:[A-Za-z]{2,}|[가-힣]{2,}))(?:\s+\2)+(?=$|[\s.,!?…])/iu.exec(text);
  if (duplicateWord) add({
    code: "repeated-word",
    category: "duplication",
    severity: "warning",
    issue: "중복 단어",
    message: `"${duplicateWord[2]}"가 연속해서 반복됩니다.`,
    reason: "동일 단어의 연속 반복은 입력 오류일 가능성이 높습니다.",
    recommendation: "중복된 단어를 하나만 남기세요.",
    originalText: text,
    suggestedText: text.replace(duplicateWord[0], `${duplicateWord[1]}${duplicateWord[2]}`),
  });

  const repeatedCharacter = /([A-Za-z가-힣])\1{3,}/u.exec(text);
  if (repeatedCharacter) add({
    code: "repeated-character",
    category: "spelling",
    severity: "suggestion",
    issue: "반복 문자",
    message: `"${repeatedCharacter[0]}"에 같은 문자가 과도하게 반복됩니다.`,
    reason: "강조가 아니라면 키 입력 오류일 수 있습니다.",
    recommendation: "의도된 강조인지 확인하고 불필요한 반복 문자를 정리하세요.",
    originalText: text,
    suggestedText: text.replace(repeatedCharacter[0], repeatedCharacter[1]),
  });

  const repeatedPunctuation = /([!?])\1{2,}|([,.])\2{2,}/u.exec(text);
  if (repeatedPunctuation) add({
    code: "repeated-punctuation",
    category: "formatting",
    severity: "suggestion",
    issue: "특수문자 반복",
    message: `문장부호 "${repeatedPunctuation[0]}"가 과도하게 반복됩니다.`,
    reason: "업무 문서에서는 반복 문장부호가 비공식적으로 보일 수 있습니다.",
    recommendation: "문맥에 맞는 문장부호 하나로 정리하세요.",
    originalText: text,
    suggestedText: text.replace(repeatedPunctuation[0], repeatedPunctuation[1] ?? repeatedPunctuation[2]),
  });

  if (/ {2,}|\t+/u.test(text)) add({
    code: "abnormal-spacing",
    category: "formatting",
    severity: "suggestion",
    issue: "비정상 공백",
    message: "문장 안에 연속 공백 또는 탭이 있습니다.",
    reason: "불규칙한 공백은 줄바꿈과 정렬을 깨뜨릴 수 있습니다.",
    recommendation: "공백을 하나로 통일하세요.",
    originalText: text,
    suggestedText: text.replace(/[ \t]+/gu, " "),
  });

  for (const [pattern, replacement, issue] of KOREAN_CORRECTIONS) {
    const match = text.match(pattern)?.[0];
    if (!match) continue;
    add({
      code: "suspected-typo",
      category: issue.includes("띄어쓰기") ? "grammar" : "spelling",
      severity: issue.includes("띄어쓰기") ? "suggestion" : "warning",
      issue,
      message: `"${match}"을(를) "${replacement}"(으)로 검토하세요.`,
      reason: issue.includes("띄어쓰기") ? "일반적인 문장 구성에서 붙여 쓰는 형태가 자연스럽습니다." : "문맥과 표준 표기에서 벗어난 철자입니다.",
      recommendation: `원문을 "${text.replace(pattern, replacement)}"(으)로 교정하는 것을 검토하세요.`,
      originalText: text,
      suggestedText: text.replace(pattern, replacement),
    });
  }
  for (const [pattern, replacement] of ENGLISH_CORRECTIONS) {
    const match = text.match(pattern)?.[0];
    if (!match) continue;
    add({
      code: "english-spelling",
      category: "spelling",
      severity: "warning",
      issue: "영문 철자 오류 가능성",
      message: `"${match}"의 철자를 확인하세요.`,
      reason: "일반 영문 사전의 고확신 오타 패턴과 일치합니다.",
      recommendation: `"${replacement}"(으)로 교정하세요.`,
      originalText: text,
      suggestedText: text.replace(pattern, replacement),
    });
  }

  const sentenceLimit = kind === "pptx" ? 90 : 140;
  const longSentence = (text.match(/[^.!?。]+[.!?。]?/gu) ?? []).find((sentence) => sentence.trim().length > sentenceLimit);
  if (longSentence) add({
    code: "long-sentence",
    category: "wording",
    severity: "suggestion",
    issue: "지나치게 긴 문장",
    message: `${longSentence.trim().length}자의 긴 문장이 있습니다.`,
    reason: kind === "pptx" ? "슬라이드의 긴 문장은 빠른 이해를 어렵게 합니다." : "긴 문장은 핵심 논리와 책임 주체를 흐릴 수 있습니다.",
    recommendation: "한 문장에 한 가지 핵심만 남기고 두 문장 이상으로 나누세요.",
    originalText: longSentence.trim(),
  });
  return findings;
}

function duplicateSentenceFindings(units: readonly TextUnit[]): CheckFinding[] {
  const sentences = new Map<string, { text: string; sources: SourceRef[] }>();
  for (const unit of units) {
    for (const sentence of unit.text.split(/(?<=[.!?。])\s+|\n+/u)) {
      const text = sentence.trim();
      if (text.length < 18) continue;
      const key = text.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
      const existing = sentences.get(key) ?? { text, sources: [] };
      existing.sources.push(unit.source);
      sentences.set(key, existing);
    }
  }
  const findings: CheckFinding[] = [];
  for (const entry of sentences.values()) {
    const sources = uniqueSources(entry.sources);
    if (sources.length < 2) continue;
    findings.push(makeFinding({
      code: "duplicate-sentence",
      category: "duplication",
      severity: "suggestion",
      issue: "중복 문장",
      message: "동일한 문장이 문서의 여러 위치에서 반복됩니다.",
      reason: "의도하지 않은 복제는 문서를 길게 만들고 버전별 수정 누락을 유발할 수 있습니다.",
      recommendation: "반복이 필요한 문장인지 확인하고 불필요한 사본을 삭제하세요.",
      sources,
      originalText: entry.text,
    }));
  }
  return findings;
}

function sentenceEndingFindings(units: readonly TextUnit[], kind: NormalizedDocument["kind"]): CheckFinding[] {
  if (!(["pptx", "docx", "pdf"] as const).includes(kind as "pptx" | "docx" | "pdf")) return [];
  const classified = units
    .filter((unit) => unit.kind === "paragraph")
    .map((unit) => ({ unit, style: /(?:습니다|입니다|합니다|됩니다)[.!?]?$/u.test(unit.text) ? "formal" : /(?:함|임|됨|음)[.!?]?$/u.test(unit.text) ? "nominal" : undefined }))
    .filter((entry): entry is { unit: TextUnit; style: "formal" | "nominal" } => Boolean(entry.style));
  const formal = classified.filter((entry) => entry.style === "formal");
  const nominal = classified.filter((entry) => entry.style === "nominal");
  if (classified.length < 3 || formal.length === 0 || nominal.length === 0 || Math.max(formal.length, nominal.length) < 2) return [];
  const minority = formal.length >= nominal.length ? nominal : formal;
  const majorityLabel = formal.length >= nominal.length ? "합니다체" : "명사형 종결";
  if (minority.length === 0 || Math.max(formal.length, nominal.length) < 2) return [];
  return [makeFinding({
    code: "sentence-ending-inconsistency",
    category: "wording",
    severity: "suggestion",
    issue: "문장 끝맺음 불일치",
    message: `문서의 주된 ${majorityLabel}와 다른 끝맺음이 섞여 있습니다.`,
    reason: "같은 수준의 본문에서 종결 방식이 달라 문서의 어조가 불균일합니다.",
    recommendation: `문서의 기준 어조인 ${majorityLabel}로 통일하세요.`,
    sources: minority.map((entry) => entry.unit.source),
    originalText: minority[0].unit.text,
  })];
}

interface TerminologyGroup {
  canonical: string;
  variants: string[];
  pattern: RegExp;
}

const TERMINOLOGY_GROUPS: readonly TerminologyGroup[] = [
  { canonical: "WorkLens", variants: ["WorkLens", "Work Lens", "Worklens"], pattern: /\b(?:WorkLens|Work Lens|Worklens)\b/gu },
  { canonical: "Forecast", variants: ["Forecast", "forecast"], pattern: /\b(?:Forecast|forecast)\b/gu },
  { canonical: "1주 Forecast", variants: ["1주 Forecast", "Forecast 1주"], pattern: /(?:1주\s+Forecast|Forecast\s+1주)/gu },
  { canonical: "개인정보", variants: ["개인정보", "개인 정보"], pattern: /(?:개인정보|개인 정보)/gu },
  { canonical: "향후 13주 전망", variants: ["향후 13주 전망", "13주 전망"], pattern: /(?:향후\s+13주\s+전망|13주\s+전망)/gu },
];

function terminologyFindings(units: readonly TextUnit[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const group of TERMINOLOGY_GROUPS) {
    const occurrences = new Map<string, { count: number; sources: SourceRef[] }>();
    for (const unit of units) {
      for (const match of unit.text.matchAll(new RegExp(group.pattern.source, group.pattern.flags))) {
        const label = match[0];
        const existing = occurrences.get(label) ?? { count: 0, sources: [] };
        existing.count += 1;
        existing.sources.push(unit.source);
        occurrences.set(label, existing);
      }
    }
    if (occurrences.size < 2) continue;
    const preferred = [...occurrences.entries()].sort((left, right) => right[1].count - left[1].count || (left[0] === group.canonical ? -1 : 1))[0][0];
    const variants = [...occurrences.keys()];
    findings.push(makeFinding({
      code: "terminology-inconsistency",
      category: "terminology",
      severity: "suggestion",
      issue: "용어 일관성",
      message: `동일 개념이 ${variants.map((variant) => `"${variant}"`).join(", ")}로 혼용됩니다.`,
      reason: "같은 개념의 표기가 달라 검색성과 문서 일관성이 낮아질 수 있습니다.",
      recommendation: `문서에서 가장 많이 사용된 "${preferred}" 표기로 통일하세요.`,
      sources: [...occurrences.values()].flatMap((entry) => entry.sources),
      originalText: variants.join(" / "),
      suggestedText: preferred,
    }));
  }
  const latinVariants = new Map<string, Map<string, SourceRef[]>>();
  const reserved = new Set(["worklens", "forecast"]);
  for (const unit of units) {
    for (const match of unit.text.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/gu)) {
      const lower = match[0].toLocaleLowerCase();
      if (reserved.has(lower)) continue;
      const variants = latinVariants.get(lower) ?? new Map<string, SourceRef[]>();
      variants.set(match[0], [...(variants.get(match[0]) ?? []), unit.source]);
      latinVariants.set(lower, variants);
    }
  }
  for (const variants of latinVariants.values()) {
    if (variants.size < 2) continue;
    const preferred = [...variants.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
    findings.push(makeFinding({
      code: "terminology-inconsistency",
      category: "terminology",
      severity: "suggestion",
      issue: "영문 대소문자 일관성",
      message: `${[...variants.keys()].map((variant) => `"${variant}"`).join(", ")} 표기가 혼용됩니다.`,
      reason: "동일한 영문 단어의 대소문자 표기가 문서 내에서 다릅니다.",
      recommendation: `"${preferred}" 표기로 통일하되 고유명사 또는 문장 첫 단어는 예외인지 확인하세요.`,
      sources: [...variants.values()].flat(),
      originalText: [...variants.keys()].join(" / "),
      suggestedText: preferred,
    }));
  }
  return findings;
}

function datesIn(unit: TextUnit): DateOccurrence[] {
  const occurrences: DateOccurrence[] = [];
  const patterns: Array<{ style: DateOccurrence["style"]; regex: RegExp }> = [
    { style: "korean", regex: /\b(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\b/gu },
    { style: "dash", regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu },
    { style: "dot", regex: /\b(\d{4})\.(\d{1,2})\.(\d{1,2})\b/gu },
    { style: "slash", regex: /\b(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\b/gu },
  ];
  for (const { style, regex } of patterns) {
    for (const match of unit.text.matchAll(regex)) {
      if (style === "slash") occurrences.push({ raw: match[0], style, ...(match[1] ? { year: Number(match[1]) } : {}), month: Number(match[2]), day: Number(match[3]), unit });
      else occurrences.push({ raw: match[0], style, year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), unit });
    }
  }
  return occurrences;
}

function reportingPeriods(units: readonly TextUnit[]): ReportingPeriod[] {
  const periods: ReportingPeriod[] = [];
  for (const unit of units) {
    for (const match of unit.text.matchAll(/\b(\d{4})년\s*(\d{1,2})월(?:\s*(?:보고서|보고|실적|계획|전망))?/gu)) {
      periods.push({ raw: match[0], year: Number(match[1]), month: Number(match[2]), unit });
    }
  }
  return periods;
}

function validDate(date: DateOccurrence): boolean {
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  const year = date.year ?? 2000;
  return date.day <= new Date(Date.UTC(year, date.month, 0)).getUTCDate();
}

function dateFindings(units: readonly TextUnit[]): CheckFinding[] {
  const dates = units.flatMap(datesIn);
  const findings: CheckFinding[] = [];
  for (const date of dates.filter((entry) => !validDate(entry))) {
    findings.push(makeFinding({
      code: "impossible-date",
      category: "date",
      severity: "warning",
      issue: "불가능한 날짜",
      message: `"${date.raw}"은(는) 달력에 존재하지 않는 날짜입니다.`,
      reason: "월 또는 일 값이 해당 연도의 달력 범위를 벗어납니다.",
      recommendation: "원본 자료에서 정확한 날짜를 확인해 수정하세요.",
      sources: [date.unit.source],
      originalText: date.raw,
    }));
  }
  const valid = dates.filter(validDate);
  const styles = new Map<DateOccurrence["style"], DateOccurrence[]>();
  for (const date of valid) styles.set(date.style, [...(styles.get(date.style) ?? []), date]);
  if (styles.size > 1) {
    const preferred = [...styles.entries()].sort((left, right) => right[1].length - left[1].length)[0];
    findings.push(makeFinding({
      code: "inconsistent-date-format",
      category: "date",
      severity: "suggestion",
      issue: "날짜 표기 방식 불일치",
      message: `날짜가 ${[...styles.keys()].map((style) => dateStyleLabel(style)).join(", ")} 형식으로 혼용됩니다.`,
      reason: "한 문서에서 날짜 형식이 다르면 기준일을 빠르게 비교하기 어렵습니다.",
      recommendation: `가장 많이 사용된 ${dateStyleLabel(preferred[0])} 형식으로 통일하세요.`,
      sources: valid.map((date) => date.unit.source),
      originalText: [...new Set(valid.map((date) => date.raw))].join(" / "),
      suggestedText: dateStyleLabel(preferred[0]),
    }));
  }

  const contextual = new Map<string, DateOccurrence[]>();
  for (const date of valid) {
    const keyword = date.unit.text.match(/(?:기준일|작성일|계약일|시행일|마감일|보고일)/u)?.[0];
    if (keyword) contextual.set(keyword, [...(contextual.get(keyword) ?? []), date]);
  }
  for (const [keyword, entries] of contextual) {
    const values = new Set(entries.map((date) => `${date.year ?? ""}-${date.month}-${date.day}`));
    const sources = uniqueSources(entries.map((date) => date.unit.source));
    if (values.size < 2 || sources.length < 2) continue;
    findings.push(makeFinding({
      code: "date-conflict",
      category: "date",
      severity: "warning",
      issue: "날짜 충돌 가능성",
      message: `동일한 "${keyword}" 문맥에 서로 다른 날짜가 사용됩니다.`,
      reason: "같은 기준을 가리키는 날짜가 다르면 버전 또는 작성 시점이 충돌할 수 있습니다.",
      recommendation: "기준시점과 적용 조건을 확인하고 날짜 또는 문맥을 명확히 구분하세요.",
      sources,
      originalText: [...new Set(entries.map((date) => date.raw))].join(" / "),
    }));
  }
  const periods = reportingPeriods(units).filter((period) => period.month >= 1 && period.month <= 12);
  const periodValues = new Set(periods.map((period) => `${period.year}-${period.month}`));
  const periodSources = uniqueSources(periods.map((period) => period.unit.source));
  if (periodValues.size > 1 && periodSources.length > 1) {
    findings.push(makeFinding({
      code: "date-conflict",
      category: "date",
      severity: "warning",
      issue: "보고 기준월 충돌 가능성",
      message: `문서에 서로 다른 보고 기준월 ${[...periodValues].join(", ")}이 사용됩니다.`,
      reason: "표지와 본문의 보고월 또는 실적월이 다르면 문서 기준시점이 충돌할 수 있습니다.",
      recommendation: "각 기준월이 의도된 비교기간인지 확인하고, 아니라면 하나의 기준월로 수정하세요.",
      sources: periodSources,
      originalText: [...new Set(periods.map((period) => period.raw))].join(" / "),
    }));
  }
  return findings;
}

function dateStyleLabel(style: DateOccurrence["style"]): string {
  return style === "korean" ? "YYYY년 M월 D일" : style === "dash" ? "YYYY-MM-DD" : style === "dot" ? "YYYY.MM.DD" : "M/D";
}

function unitAndFormatFindings(units: readonly TextUnit[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const styleGroups = [
    { code: "inconsistent-unit-format" as const, issue: "거리 단위 표기 불일치", variants: ["km", "KM"], regex: /\b(?:km|KM)\b/gu },
    { code: "inconsistent-unit-format" as const, issue: "무게 단위 표기 불일치", variants: ["kg", "KG"], regex: /\b(?:kg|KG)\b/gu },
    { code: "inconsistent-unit-format" as const, issue: "면적 단위 표기 불일치", variants: ["m²", "㎡"], regex: /(?:m²|㎡)/gu },
  ];
  for (const group of styleGroups) {
    const used = new Map<string, SourceRef[]>();
    for (const unit of units) for (const match of unit.text.matchAll(group.regex)) used.set(match[0], [...(used.get(match[0]) ?? []), unit.source]);
    if (used.size < 2) continue;
    const preferred = [...used.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
    findings.push(makeFinding({
      code: group.code,
      category: "unit",
      severity: "suggestion",
      issue: group.issue,
      message: `${group.variants.join(" / ")} 표기가 한 문서에 함께 사용됩니다.`,
      reason: "동일 단위의 대소문자 또는 기호 표기가 다릅니다.",
      recommendation: `"${preferred}" 표기로 통일하세요.`,
      sources: [...used.values()].flat(),
      originalText: [...used.keys()].join(" / "),
      suggestedText: preferred,
    }));
  }

  const percentStyles = new Map<"attached" | "spaced", SourceRef[]>();
  const currency = new Map<string, SourceRef[]>();
  const numberGrouping = new Map<"comma" | "plain", SourceRef[]>();
  for (const unit of units) {
    for (const match of unit.text.matchAll(/-?\d+(?:[.,]\d+)?(\s*)%/gu)) {
      percentStyles.set(match[1] ? "spaced" : "attached", [...(percentStyles.get(match[1] ? "spaced" : "attached") ?? []), unit.source]);
    }
    const malformed = unit.text.match(/(?:\d+(?:\.\d+)?\s*%%|%\s*\d+)/u)?.[0];
    if (malformed) findings.push(makeFinding({
      code: "malformed-percentage",
      category: "numeric",
      severity: "warning",
      issue: "잘못된 백분율 표기",
      message: `"${malformed}"은(는) 일반적인 백분율 형식이 아닙니다.`,
      reason: "백분율 기호의 위치 또는 개수가 올바르지 않습니다.",
      recommendation: "숫자 뒤에 % 기호 하나를 사용하세요.",
      sources: [unit.source],
      originalText: malformed,
    }));
    for (const match of unit.text.matchAll(/-?\d[\d,]*(?:\.\d+)?\s*(억원|백만원|천원|원)\b/gu)) currency.set(match[1], [...(currency.get(match[1]) ?? []), unit.source]);
    for (const match of unit.text.matchAll(/\b\d{4,}\b|\b\d{1,3}(?:,\d{3})+\b/gu)) {
      const style = match[0].includes(",") ? "comma" : "plain";
      numberGrouping.set(style, [...(numberGrouping.get(style) ?? []), unit.source]);
    }
  }
  if (percentStyles.size > 1) findings.push(makeFinding({
    code: "inconsistent-unit-format",
    category: "unit",
    severity: "suggestion",
    issue: "백분율 간격 불일치",
    message: "숫자와 % 기호 사이의 공백 사용이 일관되지 않습니다.",
    reason: "10%와 10 % 형식이 함께 사용됩니다.",
    recommendation: "숫자와 %를 붙여 쓰는 형식으로 통일하세요.",
    sources: [...percentStyles.values()].flat(),
    originalText: "10% / 10 %",
    suggestedText: "10%",
  }));
  if (currency.size > 1) findings.push(makeFinding({
    code: "inconsistent-currency-format",
    category: "unit",
    severity: "suggestion",
    issue: "금액 단위 혼용",
    message: `금액 단위 ${[...currency.keys()].join(", ")}가 한 문서에서 혼용됩니다.`,
    reason: "표시 단위가 다르면 금액을 직접 비교할 때 오해가 생길 수 있습니다.",
    recommendation: "기준 금액 단위를 통일하거나 각 수치의 단위를 명확히 표시하세요.",
    sources: [...currency.values()].flat(),
    originalText: [...currency.keys()].join(" / "),
  }));
  if (numberGrouping.size > 1) findings.push(makeFinding({
    code: "inconsistent-number-format",
    category: "formatting",
    severity: "suggestion",
    issue: "천 단위 구분 형식 불일치",
    message: "네 자리 이상 숫자의 쉼표 표기가 일관되지 않습니다.",
    reason: "1,000과 1000 형식이 함께 사용됩니다.",
    recommendation: "천 단위 쉼표 사용 여부를 하나의 기준으로 통일하세요.",
    sources: [...numberGrouping.values()].flat(),
    originalText: "1,000 / 1000",
  }));
  return findings;
}

function numberOccurrences(units: readonly TextUnit[]): NumberOccurrence[] {
  const occurrences: NumberOccurrence[] = [];
  const pattern = /(?:^|[.!?\n])\s*([가-힣A-Za-z][가-힣A-Za-z ]{0,30}?)\s*(?::|은|는)?\s+(-?\d[\d,]*(?:\.\d+)?)\s*(%|억원|백만원|천원|원|km|KM|kg|KG|m²|㎡)?(?=$|[\s,.;!?])/gu;
  for (const unit of units.filter((entry) => entry.kind === "paragraph")) {
    const withoutDates = unit.text.replace(/\b\d{4}(?:[.-]\d{1,2}){2}\b|\b\d{4}년\s*\d{1,2}월(?:\s*\d{1,2}일)?/gu, "");
    for (const match of withoutDates.matchAll(pattern)) {
      const label = match[1].normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      if (label.length < 2 || /(?:slide|page|슬라이드|페이지|버전)$/iu.test(label)) continue;
      const value = Number(match[2].replaceAll(",", ""));
      if (!Number.isFinite(value)) continue;
      occurrences.push({ label, value, raw: match[0].trim(), unitLabel: canonicalUnit(match[3] ?? ""), unit });
    }
  }
  return occurrences;
}

function canonicalUnit(unit: string): string {
  const lower = unit.toLocaleLowerCase();
  if (lower === "km" || lower === "kg") return lower;
  if (unit === "m²" || unit === "㎡") return "area";
  return unit;
}

function numericConflictFindings(units: readonly TextUnit[]): CheckFinding[] {
  const groups = new Map<string, NumberOccurrence[]>();
  for (const occurrence of numberOccurrences(units)) {
    const key = `${occurrence.label}\0${occurrence.unitLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), occurrence]);
  }
  const findings: CheckFinding[] = [];
  for (const entries of groups.values()) {
    const values = new Set(entries.map((entry) => entry.value));
    const sources = uniqueSources(entries.map((entry) => entry.unit.source));
    if (values.size < 2 || sources.length < 2) continue;
    const numeric = [...values];
    const minimum = Math.min(...numeric.map(Math.abs).filter((value) => value > 0));
    const maximum = Math.max(...numeric.map(Math.abs));
    const suspicious = Number.isFinite(minimum) && maximum / minimum >= 10;
    findings.push(makeFinding({
      code: suspicious ? "suspicious-number-change" : "repeated-number-conflict",
      category: "numeric",
      severity: "warning",
      issue: suspicious ? "급격한 수치 변화" : "동일 항목 수치 불일치",
      message: `"${entries[0].label}" 항목에 서로 다른 값 ${numeric.join(", ")}이 사용됩니다.`,
      reason: suspicious ? "동일 항목의 값 차이가 10배 이상이어서 단위 또는 입력 오류 가능성이 있습니다." : "같은 항목과 단위로 보이는 수치가 문서 내에서 일치하지 않습니다.",
      recommendation: "기준시점, 조건과 단위를 확인하고 의도된 차이라면 문맥을 명시하세요.",
      sources,
      originalText: entries.map((entry) => entry.raw).join(" / "),
    }));
  }
  return findings;
}

function totalForTable(table: TableBlock): ExplicitTotal[] {
  const totals: ExplicitTotal[] = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex];
    const labelCell = row.find((cell) => !isEmpty(cell));
    if (!labelCell || !TOTAL_LABEL.test(textOf(labelCell))) continue;
    for (let column = 0; column < row.length; column += 1) {
      const actual = numericValue(row[column]);
      if (actual === undefined) continue;
      const contributors: TableCell[] = [];
      for (let previous = rowIndex - 1; previous >= 0; previous -= 1) {
        const candidate = table.rows[previous][column];
        if (!candidate || numericValue(candidate) === undefined) break;
        contributors.unshift(candidate);
      }
      if (contributors.length < 2) continue;
      totals.push({
        label: textOf(labelCell),
        expected: contributors.reduce((sum, cell) => sum + (numericValue(cell) ?? 0), 0),
        actual,
        source: row[column].source,
        contributingSources: contributors.map((cell) => cell.source),
      });
    }
  }
  return totals;
}

function tableFindings(table: TableBlock): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const duplicates = new Map<number, Map<string, SourceRef[]>>();
  const formats = new Map<number, Map<string, SourceRef[]>>();
  table.rows.forEach((row, rowIndex) => {
    if (row.length > 0 && row.every(isEmpty)) findings.push(makeFinding({
      code: "empty-row",
      category: "structure",
      severity: "suggestion",
      issue: "빈 행",
      message: `${rowIndex + 1}행의 모든 셀이 비어 있습니다.`,
      reason: "내용 없는 행은 데이터 범위와 정렬을 모호하게 만듭니다.",
      recommendation: "의도된 여백이 아니라면 빈 행을 삭제하세요.",
      sources: row.map((cell) => cell.source),
    }));
    row.forEach((cell, column) => {
      if (isEmpty(cell)) {
        findings.push(makeFinding({
          code: "empty-cell",
          category: "structure",
          severity: "suggestion",
          issue: "빈 셀",
          message: `${column + 1}열의 셀 값이 비어 있습니다.`,
          reason: "필수 값이 누락되었거나 의도적으로 비운 셀일 수 있습니다.",
          recommendation: "의도된 빈 값인지 확인하세요.",
          sources: [cell.source],
        }));
        const above = rowIndex > 0 ? table.rows[rowIndex - 1]?.[column] : undefined;
        const below = table.rows[rowIndex + 1]?.[column];
        if (above && below && numericValue(above) !== undefined && numericValue(below) !== undefined) findings.push(makeFinding({
          code: "missing-value-in-series",
          category: "numeric",
          severity: "warning",
          issue: "연속 데이터 값 누락",
          message: "연속된 수치 사이의 값이 비어 있습니다.",
          reason: "같은 열의 앞뒤 값이 숫자여서 시계열 또는 연속 데이터 누락 가능성이 높습니다.",
          recommendation: "원본 자료에서 누락된 값을 확인하고 입력하세요.",
          sources: [cell.source, above.source, below.source],
        }));
      }
      const text = textOf(cell);
      if (text) {
        const byValue = duplicates.get(column) ?? new Map<string, SourceRef[]>();
        const key = text.normalize("NFKC").toLocaleLowerCase();
        byValue.set(key, [...(byValue.get(key) ?? []), cell.source]);
        duplicates.set(column, byValue);
      }
      const numeric = parseCanonicalNumber(text);
      if (numeric) {
        const byFormat = formats.get(column) ?? new Map<string, SourceRef[]>();
        byFormat.set(numeric.format, [...(byFormat.get(numeric.format) ?? []), cell.source]);
        formats.set(column, byFormat);
      }
    });
  });
  for (const values of duplicates.values()) for (const [value, sources] of values) {
    if (sources.length > 1) findings.push(makeFinding({
      code: "duplicate-value",
      category: "duplication",
      severity: "warning",
      issue: "중복 값",
      message: `동일 열에 "${value}" 값이 반복됩니다.`,
      reason: "동일 열에 같은 값이 반복되어 중복 레코드일 가능성이 있습니다.",
      recommendation: "중복이 업무상 유효한지 확인하세요.",
      sources,
      originalText: value,
    }));
  }
  for (const [column, values] of formats) if (values.size > 1) findings.push(makeFinding({
    code: "inconsistent-number-format",
    category: "formatting",
    severity: "warning",
    issue: "숫자 형식 불일치",
    message: `${column + 1}열에서 서로 다른 숫자 표시 형식이 사용됩니다.`,
    reason: "동일 열의 천 단위, 소수점 또는 통화 표시 방식이 다릅니다.",
    recommendation: "숫자 형식을 하나로 통일하세요.",
    sources: [...values.values()].flat(),
  }));
  for (const total of totalForTable(table)) if (Math.abs(total.actual - total.expected) > 1e-9) findings.push(makeFinding({
    code: "invalid-total",
    category: "total",
    severity: "critical",
    issue: "합계 불일치",
    message: `합계 "${total.label}"의 표시값 ${total.actual}과 계산값 ${total.expected}이 다릅니다.`,
    reason: "표시된 합계와 구성 값의 계산 결과가 다릅니다.",
    recommendation: "합계 수식 또는 구성 값을 수정하세요.",
    sources: [total.source, ...total.contributingSources],
    originalText: String(total.actual),
    suggestedText: String(total.expected),
  }));
  return findings;
}

function structureFindings(document: NormalizedDocument, units: readonly TextUnit[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  if (document.kind === "pdf" && (document.warnings.includes("PDF_TEXT_LAYER_EMPTY") || units.length === 0)) {
    const source: SourceRef = document.blocks[0]?.source ?? {
      fileId: document.fileId,
      documentId: document.id,
      ...(document.version ? { documentVersion: document.version } : {}),
      nodeId: `${document.id}:page:1`,
      label: "페이지 1",
      page: 1,
      quote: "",
    };
    findings.push(makeFinding({
      code: "ocr-text-unavailable",
      category: "structure",
      severity: "warning",
      issue: "PDF 텍스트 추출 제한",
      message: "텍스트 레이어가 없거나 추출할 수 있는 텍스트가 제한적입니다.",
      reason: "스캔 이미지 PDF는 V1에서 OCR 검수를 지원하지 않습니다.",
      recommendation: "텍스트 선택이 가능한 PDF 또는 원본 문서로 다시 확인하세요.",
      sources: [source],
    }));
  }
  if (document.kind === "docx") {
    const headings = units.filter((unit) => unit.headingLevel !== undefined);
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1].headingLevel!;
      const current = headings[index].headingLevel!;
      if (current > previous + 1) findings.push(makeFinding({
        code: "heading-hierarchy",
        category: "structure",
        severity: "warning",
        issue: "제목 계층 건너뜀",
        message: `Heading ${previous} 다음에 Heading ${current}이 사용됩니다.`,
        reason: "제목 단계가 중간 수준을 건너뛰어 문서 구조를 이해하기 어렵습니다.",
        recommendation: "제목 수준을 순차적으로 구성하세요.",
        sources: [headings[index - 1].source, headings[index].source],
        originalText: headings[index].text,
      }));
    }
    const numbered = headings.map((unit) => ({ unit, match: /^(\d+(?:\.\d+)*)([.)]?)\s+/u.exec(unit.text) })).filter((entry) => entry.match);
    const delimiters = new Set(numbered.map((entry) => entry.match![2] || "none"));
    if (delimiters.size > 1) findings.push(makeFinding({
      code: "heading-numbering-inconsistency",
      category: "formatting",
      severity: "suggestion",
      issue: "제목 번호 체계 불일치",
      message: "제목 번호 뒤의 구두점 형식이 일관되지 않습니다.",
      reason: "같은 문서에서 1., 1), 1 형식이 혼용됩니다.",
      recommendation: "하나의 제목 번호 형식으로 통일하세요.",
      sources: numbered.map((entry) => entry.unit.source),
      originalText: numbered.map((entry) => entry.match![0].trim()).join(" / "),
    }));
  }
  if (document.kind === "pptx") {
    const bySlide = new Map<number, TextUnit[]>();
    for (const unit of units.filter((entry) => entry.kind === "paragraph" && entry.page !== undefined)) bySlide.set(unit.page!, [...(bySlide.get(unit.page!) ?? []), unit]);
    const titles = [...bySlide.values()].map((content) => content[0]).filter((title): title is TextUnit => Boolean(title) && title.text.length <= 140);
    const titlePunctuation = new Map<"punctuated" | "plain", TextUnit[]>();
    for (const title of titles) {
      const style = /[.!?:：]$/u.test(title.text) ? "punctuated" : "plain";
      titlePunctuation.set(style, [...(titlePunctuation.get(style) ?? []), title]);
    }
    if (titlePunctuation.size > 1 && titles.length >= 3) {
      const preferred = [...titlePunctuation.entries()].sort((left, right) => right[1].length - left[1].length)[0][0];
      findings.push(makeFinding({
        code: "title-format-inconsistency",
        category: "formatting",
        severity: "suggestion",
        issue: "슬라이드 제목 표기 불일치",
        message: "슬라이드 제목의 문장부호 사용이 일관되지 않습니다.",
        reason: "같은 수준의 제목 일부에만 마침표 또는 콜론이 사용됩니다.",
        recommendation: preferred === "plain" ? "제목 끝의 불필요한 문장부호를 제거하세요." : "제목 문장부호를 하나의 형식으로 통일하세요.",
        sources: titles.map((title) => title.source),
        originalText: titles.map((title) => title.text).join(" / "),
      }));
    }
    for (let slide = 1; slide <= (document.metadata.pageCount ?? 0); slide += 1) {
      const content = bySlide.get(slide) ?? [];
      const first = content[0];
      if (!first || first.text.length > 140) {
        const source = first?.source ?? {
          fileId: document.fileId,
          documentId: document.id,
          ...(document.version ? { documentVersion: document.version } : {}),
          nodeId: `${document.id}:slide:${slide}`,
          label: `슬라이드 ${slide}`,
          page: slide,
          quote: "",
        };
        findings.push(makeFinding({
          code: "missing-slide-title",
          category: "structure",
          severity: "suggestion",
          issue: "제목 없는 슬라이드 가능성",
          message: `슬라이드 ${slide}에서 짧고 명확한 제목을 확인하기 어렵습니다.`,
          reason: "첫 텍스트 블록이 없거나 제목으로 보기에는 지나치게 깁니다.",
          recommendation: "슬라이드 핵심 메시지를 담은 짧은 제목을 추가하세요.",
          sources: [source],
          ...(first ? { originalText: first.text } : {}),
        }));
      }
      const characterCount = content.reduce((sum, unit) => sum + unit.text.length, 0);
      if (characterCount > 650 && first) findings.push(makeFinding({
        code: "excessive-slide-text",
        category: "structure",
        severity: "suggestion",
        issue: "슬라이드 텍스트 과다",
        message: `슬라이드 ${slide}에 ${characterCount}자의 텍스트가 있습니다.`,
        reason: "한 슬라이드에 많은 텍스트가 있으면 발표와 빠른 검토가 어렵습니다.",
        recommendation: "핵심 메시지만 남기고 상세 내용은 부록 또는 발표자 노트로 이동하세요.",
        sources: content.map((unit) => unit.source),
      }));
    }
  }
  return findings;
}

function mergeFindings(findings: readonly CheckFinding[]): CheckFinding[] {
  const severityRank: Record<CheckSeverity, number> = { critical: 3, warning: 2, suggestion: 1 };
  const merged = new Map<string, CheckFinding>();
  for (const finding of findings) {
    const sourceKey = finding.sources.map((source) => `${source.fileId}:${source.nodeId}`).sort().join("|");
    const textKey = (finding.originalText ?? finding.message).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
    const family = finding.category === "spelling" || finding.category === "grammar" ? "language" : finding.code;
    const key = `${family}\0${textKey}\0${sourceKey}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, finding);
      continue;
    }
    const preferred = severityRank[finding.severity] > severityRank[previous.severity] ? finding : previous;
    merged.set(key, { ...preferred, sources: uniqueSources([...previous.sources, ...finding.sources]), source: preferred.source });
  }
  const result = [...merged.values()]
    .sort((left, right) => severityRank[right.severity] - severityRank[left.severity])
    .slice(0, MAX_FINDINGS);
  const idsByCode = new Map<CheckCode, string[]>();
  for (const finding of result) idsByCode.set(finding.code, [...(idsByCode.get(finding.code) ?? []), finding.id]);
  return result.map((finding) => {
    const related = (idsByCode.get(finding.code) ?? []).filter((id) => id !== finding.id).slice(0, 5);
    return related.length ? { ...finding, relatedFindingIds: related } : finding;
  });
}

export function checkDocument(document: NormalizedDocument): CheckResult {
  const units = collectTextUnits(document);
  const findings: CheckFinding[] = [];
  for (const unit of units) {
    findings.push(...privacyFindings(unit));
    findings.push(...writingFindings(unit, document.kind));
  }
  for (const block of document.blocks) if (block.type === "table") findings.push(...tableFindings(block));
  findings.push(...duplicateSentenceFindings(units));
  findings.push(...sentenceEndingFindings(units, document.kind));
  findings.push(...terminologyFindings(units));
  findings.push(...dateFindings(units));
  findings.push(...unitAndFormatFindings(units));
  findings.push(...numericConflictFindings(units));
  findings.push(...structureFindings(document, units));
  return { documentId: document.id, findings: mergeFindings(findings) };
}
