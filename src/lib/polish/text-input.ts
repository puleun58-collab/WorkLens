import { MAX_EVIDENCE_CHARS } from "@/lib/ai/prompt";
import { POLISH_SEGMENT_MAX_CHARS, isProse } from "./candidates";

/**
 * Pasted-text input for Polish.
 *
 * The file path selects prose from a parsed document; this path has no
 * document, only what the user pasted. It is therefore split here — never in
 * the prompt — so the model still sees one bounded prose segment at a time and
 * the structure the user pasted (line breaks, bullets, numbering, blank lines)
 * is restored from the original text rather than from the model's answer.
 */

/**
 * One request's context budget, the same window the AI eval already scores for
 * the model that ships (`MAX_EVIDENCE_CHARS`). A longer paste is split across
 * several requests, so this bounds a whole run, not one segment.
 */
export const POLISH_TEXT_MAX_CHARS = MAX_EVIDENCE_CHARS;

export const POLISH_TEXT_TOO_LONG_MESSAGE =
  `한 번에 처리할 수 있는 텍스트 길이를 초과했습니다. ${POLISH_TEXT_MAX_CHARS.toLocaleString("ko-KR")}자 이하로 나눠서 윤문해 주세요.`;

/** A list marker or indentation kept verbatim so the structure survives. */
const MARKER = /^(\s*(?:[-*•·]|\d+[.)]|[가-힣][.)])\s+)/u;

export interface PolishTextSegment {
  id: string;
  /** Bullet, number or indentation prefix, re-attached on reassembly. */
  prefix: string;
  text: string;
  /** How this segment joins the previous one: a new line, or the same line. */
  joiner: "\n" | " ";
  /** Only prose is sent to the model; blank lines and values pass through. */
  polishable: boolean;
}

function sentenceChunks(text: string): string[] {
  if (text.length <= POLISH_SEGMENT_MAX_CHARS) return [text];
  const sentences = text.match(/[^.!?。]+[.!?。]*\s*/gu) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > POLISH_SEGMENT_MAX_CHARS) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += sentence;
    while (current.length > POLISH_SEGMENT_MAX_CHARS) {
      chunks.push(current.slice(0, POLISH_SEGMENT_MAX_CHARS));
      current = current.slice(POLISH_SEGMENT_MAX_CHARS);
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

/**
 * Splits pasted text line by line. A line is the unit the user typed, so it is
 * also the unit that is rewritten: bullets stay bullets, a blank line stays a
 * paragraph break, and an over-long line is cut at sentence boundaries.
 */
export function splitPolishText(input: string): PolishTextSegment[] {
  const segments: PolishTextSegment[] = [];
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  lines.forEach((line, lineIndex) => {
    const marker = MARKER.exec(line);
    const prefix = marker?.[1] ?? "";
    const body = line.slice(prefix.length);
    const chunks = body.trim() ? sentenceChunks(body) : [body];
    chunks.forEach((chunk, chunkIndex) => {
      segments.push({
        id: `paste:${lineIndex + 1}:${chunkIndex + 1}`,
        prefix: chunkIndex === 0 ? prefix : "",
        text: chunk,
        joiner: chunkIndex === 0 ? "\n" : " ",
        polishable: isProse(chunk),
      });
    });
  });
  return segments;
}

/** Puts the run back together in input order, structure first. */
export function assemblePolishText(
  segments: readonly PolishTextSegment[],
  revisedById: ReadonlyMap<string, string>,
): string {
  return segments
    .map((segment, index) => {
      const text = revisedById.get(segment.id) ?? segment.text;
      const body = `${segment.prefix}${text}`;
      if (index === 0) return body;
      return segment.joiner === "\n" ? `\n${body}` : ` ${body}`;
    })
    .join("");
}
