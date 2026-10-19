import type { LearnContent, LearnLevelNo } from "./types";

// 단계별 콘텐츠는 content-l01.ts ~ content-l10.ts 에서 정의한다.
import { CONTENT_L01 } from "./content-l01";
import { CONTENT_L02 } from "./content-l02";
import { CONTENT_L03 } from "./content-l03";
import { CONTENT_L04 } from "./content-l04";
import { CONTENT_L05 } from "./content-l05";
import { CONTENT_L06 } from "./content-l06";
import { CONTENT_L07 } from "./content-l07";
import { CONTENT_L08 } from "./content-l08";
import { CONTENT_L09 } from "./content-l09";
import { CONTENT_L10 } from "./content-l10";

const CONTENTS: Record<LearnLevelNo, LearnContent> = {
  1: CONTENT_L01,
  2: CONTENT_L02,
  3: CONTENT_L03,
  4: CONTENT_L04,
  5: CONTENT_L05,
  6: CONTENT_L06,
  7: CONTENT_L07,
  8: CONTENT_L08,
  9: CONTENT_L09,
  10: CONTENT_L10,
};

export function levelContent(level: LearnLevelNo): LearnContent {
  const content = CONTENTS[level];
  if (!content) throw new Error(`LEVEL ${level} 콘텐츠가 없습니다.`);
  return content;
}

export function allContents(): LearnContent[] {
  return ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as LearnLevelNo[]).map(levelContent);
}
