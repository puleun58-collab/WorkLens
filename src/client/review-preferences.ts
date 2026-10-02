/** Browser-local presentation preferences only. Never accept or persist document content. */
export interface ReviewPreferences {
  documentSource: "file" | "text";
  expandSources: boolean;
}
export const REVIEW_PREFERENCES_KEY = "worklens:review-preferences:v1";
export const SYSTEM_REVIEW_PREFERENCES: Readonly<ReviewPreferences> = { documentSource: "file", expandSources: false };
type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PreferenceRead = { preferences: ReviewPreferences | null; error: string | null };
export type PreferenceWrite = { ok: true } | { ok: false; error: string };
const STORAGE_ERROR = "브라우저 저장소에 접근할 수 없습니다. 검토 설정은 이번 화면에서만 적용됩니다.";
const INVALID_ERROR = "저장된 검토 설정이 현재 버전과 맞지 않아 시스템 기본값을 적용했습니다. 다시 저장하거나 초기화하세요.";
function browserStorage(): PreferenceStorage {
  if (typeof window === "undefined") throw new Error("Browser storage unavailable");
  return window.localStorage;
}
function validPreferences(value: unknown): value is ReviewPreferences {
  if (!value || typeof value !== "object") return false;
  const preferences = value as Partial<ReviewPreferences>;
  return (preferences.documentSource === "file" || preferences.documentSource === "text") && typeof preferences.expandSources === "boolean";
}
export function resolveReviewPreferences(saved: ReviewPreferences | null, override: Partial<ReviewPreferences> = {}): ReviewPreferences {
  return { ...SYSTEM_REVIEW_PREFERENCES, ...saved, ...override };
}
export function readReviewPreferences(storage?: PreferenceStorage): PreferenceRead {
  try {
    const raw = (storage ?? browserStorage()).getItem(REVIEW_PREFERENCES_KEY);
    if (raw === null) return { preferences: null, error: null };
    let envelope: unknown;
    try { envelope = JSON.parse(raw); }
    catch { return { preferences: null, error: INVALID_ERROR }; }
    if (!envelope || typeof envelope !== "object" || !("version" in envelope) || envelope.version !== 1
      || !("preferences" in envelope) || !validPreferences(envelope.preferences)) {
      return { preferences: null, error: INVALID_ERROR };
    }
    return { preferences: { documentSource: envelope.preferences.documentSource, expandSources: envelope.preferences.expandSources }, error: null };
  } catch {
    return { preferences: null, error: STORAGE_ERROR };
  }
}
export function saveReviewPreferences(preferences: ReviewPreferences, storage?: PreferenceStorage): PreferenceWrite {
  if (!validPreferences(preferences)) return { ok: false, error: "지원하지 않는 검토 설정입니다." };
  try {
    (storage ?? browserStorage()).setItem(REVIEW_PREFERENCES_KEY, JSON.stringify({ version: 1,
      preferences: { documentSource: preferences.documentSource, expandSources: preferences.expandSources } }));
    return { ok: true };
  } catch { return { ok: false, error: "검토 설정을 저장하지 못했습니다. 브라우저 저장소 권한과 여유 공간을 확인하세요. 기존 기본값은 유지됩니다." }; }
}
export function resetReviewPreferences(storage?: PreferenceStorage): PreferenceWrite {
  try {
    (storage ?? browserStorage()).removeItem(REVIEW_PREFERENCES_KEY);
    return { ok: true };
  } catch { return { ok: false, error: "검토 설정을 초기화하지 못했습니다. 기존 기본값은 유지됩니다." }; }
}
