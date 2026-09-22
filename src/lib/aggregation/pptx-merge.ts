import { strToU8, zipSync } from "fflate";
import { unzipOoxml } from "@/lib/parsers/ooxml-zip";
import { FORMAT_INPUT_LIMITS } from "@/lib/parsers/policy";
import { DocumentError } from "@/lib/upload";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SLIDE_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const MASTER_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const NOTES_SLIDE_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const NOTES_MASTER_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const MASTER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export interface PresentationInput {
  fileId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface PresentationMerge {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
  slideCount: number;
  /** Speaker notes are not carried across decks; reported, never claimed. */
  droppedNotes: number;
  /** Decks whose slide size differs from the first deck's. */
  resizedDecks: number;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

const unreadable = (fileName: string): Error => new DocumentError(
  "DOCUMENT_UNREADABLE",
  `${fileName} 파일을 읽지 못했습니다.`,
  "지원되는 PowerPoint 파일인지 확인한 뒤 다시 시도해 주세요.",
);

const tooLarge = (fileName: string): Error => new DocumentError(
  "DOCUMENT_TOO_COMPLEX",
  `${fileName} 파일의 구조가 너무 큽니다.`,
  "슬라이드 수나 포함된 미디어를 줄인 뒤 다시 시도해 주세요.",
);

const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

const attributeOf = (element: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "u").exec(element);
  return match?.[1];
};

const escapeXml = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** Package paths are absolute; a relationship target is relative to its own part. */
function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${directoryOf(partPath)}${target}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function relativeTarget(fromPart: string, toPart: string): string {
  const from = directoryOf(fromPart).split("/").filter(Boolean);
  const to = toPart.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...Array.from({ length: from.length - shared }, () => ".."), ...to.slice(shared)].join("/");
}

function relationshipsIn(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\/?>/gu)].flatMap((match) => {
    const element = match[0];
    const id = attributeOf(element, "Id");
    const type = attributeOf(element, "Type");
    const target = attributeOf(element, "Target");
    if (!id || !type || !target) return [];
    return [{ id, type, target, external: attributeOf(element, "TargetMode") === "External" }];
  });
}

function relationshipsXml(relationships: readonly Relationship[]): string {
  const entries = relationships.map((relationship) =>
    `<Relationship Id="${escapeXml(relationship.id)}" Type="${escapeXml(relationship.type)}" Target="${escapeXml(relationship.target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

const relsPathOf = (partPath: string): string =>
  `${directoryOf(partPath)}_rels/${partPath.slice(partPath.lastIndexOf("/") + 1)}.rels`;

function readPackage(input: PresentationInput): Map<string, Uint8Array> {
  return unzipOoxml(input.bytes, {
    maxInputBytes: FORMAT_INPUT_LIMITS.pptx,
    keepOtherParts: true,
    malformed: () => unreadable(input.fileName),
    limitExceeded: () => tooLarge(input.fileName),
  });
}

/** Slides in presentation order, which is the order the author sees. */
function slidePathsOf(parts: Map<string, Uint8Array>, fileName: string): string[] {
  const relationships = parts.get("ppt/_rels/presentation.xml.rels");
  const presentation = parts.get("ppt/presentation.xml");
  if (!relationships || !presentation) throw unreadable(fileName);
  const byId = new Map(relationshipsIn(decode(relationships))
    .filter((relationship) => relationship.type === SLIDE_TYPE && !relationship.external)
    .map((relationship) => [relationship.id, resolveTarget("ppt/presentation.xml", relationship.target)]));
  const ordered = [...decode(presentation).matchAll(/<p:sldId\b[^>]*\/?>/gu)].flatMap((match) => {
    const id = attributeOf(match[0], "r:id");
    const path = id === undefined ? undefined : byId.get(id);
    return path !== undefined && parts.has(path) ? [path] : [];
  });
  if (ordered.length === 0) throw unreadable(fileName);
  return ordered;
}

function contentTypeIndex(parts: Map<string, Uint8Array>, fileName: string): {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
} {
  const raw = parts.get("[Content_Types].xml");
  if (!raw) throw unreadable(fileName);
  const xml = decode(raw);
  const defaults = new Map([...xml.matchAll(/<Default\b[^>]*\/?>/gu)].flatMap((match) => {
    const extension = attributeOf(match[0], "Extension");
    const type = attributeOf(match[0], "ContentType");
    return extension && type ? [[extension.toLowerCase(), type] as const] : [];
  }));
  const overrides = new Map([...xml.matchAll(/<Override\b[^>]*\/?>/gu)].flatMap((match) => {
    const part = attributeOf(match[0], "PartName");
    const type = attributeOf(match[0], "ContentType");
    return part && type ? [[part.replace(/^\//u, ""), type] as const] : [];
  }));
  return { defaults, overrides };
}

const slideSizeOf = (parts: Map<string, Uint8Array>): string => {
  const presentation = parts.get("ppt/presentation.xml");
  if (!presentation) return "";
  const match = /<p:sldSz\b[^>]*\/?>/u.exec(decode(presentation));
  return match ? `${attributeOf(match[0], "cx") ?? ""}x${attributeOf(match[0], "cy") ?? ""}` : "";
};

function insertBefore(xml: string, closingTag: string, addition: string): string {
  const index = xml.lastIndexOf(closingTag);
  if (index < 0) return xml;
  return `${xml.slice(0, index)}${addition}${xml.slice(index)}`;
}

/**
 * Merges presentations by copying slide parts and everything they depend on.
 *
 * Copying the original parts — slide XML, its layout, master, theme and media —
 * preserves the authored layout; rebuilding slides from extracted text would
 * not. Speaker notes are the one part deliberately left behind, because a notes
 * slide belongs to its own deck's notes master.
 */
export function mergePresentations(decks: readonly PresentationInput[]): PresentationMerge {
  if (decks.length === 0) throw new DocumentError("NO_FILE_SELECTED", "파일을 1개 이상 선택하세요.");
  const [first, ...rest] = decks;
  const output = new Map(readPackage(first));
  const baseSize = slideSizeOf(output);
  const baseTypes = contentTypeIndex(output, first.fileName);
  let slideCount = slidePathsOf(output, first.fileName).length;
  let droppedNotes = 0;
  let resizedDecks = 0;
  /**
   * Slide masters and slide layouts share one id space in a presentation, and
   * decks built from the same template reuse the same ids. PowerPoint rejects
   * the package outright when two of them collide, so copied masters and their
   * layout lists are renumbered above everything already in use. Slides point
   * at layouts through relationships, never through these ids.
   */
  const designIds = new Set([...output.values()].flatMap((bytes) =>
    [...decode(bytes).matchAll(/<p:(?:sldLayoutId|sldMasterId)\b[^>]*\sid="(\d+)"/gu)].map((match) => Number(match[1]))));
  let designIdSeed = Math.max(2_147_483_648, ...designIds);
  const nextDesignId = (): number => {
    designIdSeed += 1;
    designIds.add(designIdSeed);
    return designIdSeed;
  };
  const renumberLayoutIds = (xml: string): string =>
    xml.replace(/(<p:sldLayoutId\b[^>]*\sid=")(\d+)(")/gu, (_match, head: string, id: string, tail: string) => {
      if (!designIds.has(Number(id))) {
        designIds.add(Number(id));
        return `${head}${id}${tail}`;
      }
      return `${head}${nextDesignId()}${tail}`;
    });

  const presentationRelsPath = "ppt/_rels/presentation.xml.rels";
  const presentationRels = relationshipsIn(decode(output.get(presentationRelsPath) ?? new Uint8Array()));
  const newDefaults = new Map<string, string>();
  const newOverrides = new Map<string, string>();
  const newSlideRels: Relationship[] = [];
  const newMasterRels: Relationship[] = [];
  let relationshipSeed = presentationRels.reduce((max, relationship) => {
    const numeric = Number(/^rId(\d+)$/u.exec(relationship.id)?.[1] ?? 0);
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
  }, 0);
  const nextRelationshipId = (): string => {
    relationshipSeed += 1;
    return `rId${relationshipSeed}`;
  };

  for (const [deckIndex, deck] of rest.entries()) {
    const parts = readPackage(deck);
    const types = contentTypeIndex(parts, deck.fileName);
    if (slideSizeOf(parts) !== baseSize) resizedDecks += 1;
    const prefix = `wl${deckIndex + 2}_`;
    const copied = new Map<string, string>();

    const copyPart = (path: string): string | undefined => {
      const existing = copied.get(path);
      if (existing) return existing;
      const bytes = parts.get(path);
      if (!bytes) return undefined;
      const directory = directoryOf(path);
      const name = path.slice(directory.length);
      const target = `${directory}${prefix}${name}`;
      copied.set(path, target);
      const type = types.overrides.get(path);
      output.set(target, type === MASTER_CONTENT_TYPE ? strToU8(renumberLayoutIds(decode(bytes))) : bytes);
      if (type) newOverrides.set(target, type);
      else {
        const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        const fallback = types.defaults.get(extension) ?? MEDIA_CONTENT_TYPES[extension];
        if (fallback && !baseTypes.defaults.has(extension)) newDefaults.set(extension, fallback);
      }
      const relsPath = relsPathOf(path);
      const rels = parts.get(relsPath);
      if (rels) {
        const kept: Relationship[] = [];
        for (const relationship of relationshipsIn(decode(rels))) {
          if (relationship.external) { kept.push(relationship); continue; }
          if (relationship.type === NOTES_SLIDE_TYPE || relationship.type === NOTES_MASTER_TYPE) {
            if (relationship.type === NOTES_SLIDE_TYPE) droppedNotes += 1;
            continue;
          }
          const resolved = resolveTarget(path, relationship.target);
          const copiedTarget = copyPart(resolved);
          if (!copiedTarget) continue;
          kept.push({ ...relationship, target: relativeTarget(target, copiedTarget) });
        }
        output.set(relsPathOf(target), strToU8(relationshipsXml(kept)));
      }
      return target;
    };

    for (const slidePath of slidePathsOf(parts, deck.fileName)) {
      const target = copyPart(slidePath);
      if (!target) continue;
      slideCount += 1;
      newSlideRels.push({
        id: nextRelationshipId(),
        type: SLIDE_TYPE,
        target: relativeTarget("ppt/presentation.xml", target),
        external: false,
      });
    }
    for (const [source, target] of copied) {
      if (types.overrides.get(source) !== MASTER_CONTENT_TYPE) continue;
      newMasterRels.push({
        id: nextRelationshipId(),
        type: MASTER_TYPE,
        target: relativeTarget("ppt/presentation.xml", target),
        external: false,
      });
    }
  }

  if (newSlideRels.length > 0 || newMasterRels.length > 0) {
    output.set(presentationRelsPath, strToU8(relationshipsXml([...presentationRels, ...newMasterRels, ...newSlideRels])));

    const presentationXml = decode(output.get("ppt/presentation.xml") ?? new Uint8Array());
    const usedSlideIds = [...presentationXml.matchAll(/<p:sldId\b[^>]*\/?>/gu)]
      .map((match) => Number(attributeOf(match[0], "id") ?? 0));
    let slideId = Math.max(255, ...usedSlideIds.filter(Number.isFinite));
    const slideEntries = newSlideRels.map((relationship) => {
      slideId += 1;
      return `<p:sldId id="${slideId}" r:id="${relationship.id}"/>`;
    }).join("");
    const masterEntries = newMasterRels.map((relationship) =>
      `<p:sldMasterId id="${nextDesignId()}" r:id="${relationship.id}"/>`).join("");
    const withMasters = masterEntries ? insertBefore(presentationXml, "</p:sldMasterIdLst>", masterEntries) : presentationXml;
    output.set("ppt/presentation.xml", strToU8(insertBefore(withMasters, "</p:sldIdLst>", slideEntries)));

    const contentTypes = decode(output.get("[Content_Types].xml") ?? new Uint8Array());
    const defaults = [...newDefaults].map(([extension, type]) =>
      `<Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(type)}"/>`).join("");
    const overrides = [...newOverrides].map(([part, type]) =>
      `<Override PartName="/${escapeXml(part)}" ContentType="${escapeXml(type)}"/>`).join("");
    output.set("[Content_Types].xml", strToU8(insertBefore(contentTypes, "</Types>", `${defaults}${overrides}`)));
  }

  return {
    fileName: "worklens-aggregation.pptx",
    mimeType: PPTX_MIME,
    content: zipSync(Object.fromEntries(output), { level: 6 }),
    slideCount,
    droppedNotes,
    resizedDecks,
  };
}
