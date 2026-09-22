import { inflateSync } from "fflate";

/**
 * One hardened reader for OOXML packages.
 *
 * Structural limits bound expansion work, not file size: only inflated parts
 * are counted, so a media-heavy deck stays admissible while zip-bomb defence is
 * unchanged. Parsing keeps just the parts it reads; repackaging keeps every
 * part, because a part it drops is content the output would lose.
 */
export const OOXML_LIMITS = {
  maxEntries: 2_000,
  maxXmlEntryBytes: 5 * 1024 * 1024,
  maxXmlTotalBytes: 30 * 1024 * 1024,
  maxMediaEntryBytes: 25 * 1024 * 1024,
  maxMediaTotalBytes: 200 * 1024 * 1024,
} as const;

export interface UnzipOoxmlOptions {
  maxInputBytes: number;
  /** Repackaging needs every part; parsing keeps only XML and media. */
  keepOtherParts: boolean;
  malformed: () => Error;
  limitExceeded: () => Error;
}

const isXmlPart = (name: string): boolean => name.endsWith(".xml") || name.endsWith(".rels");
const isMediaPart = (name: string): boolean => name.includes("/media/");

export function unzipOoxml(input: Uint8Array, options: UnzipOoxmlOptions): Map<string, Uint8Array> {
  const malformedFileError = options.malformed;
  const structureLimitError = options.limitExceeded;
  const uint16 = (bytes: Uint8Array, offset: number): number => {
    if (offset < 0 || offset + 2 > bytes.byteLength) throw malformedFileError();
    return bytes[offset] | (bytes[offset + 1] << 8);
  };
  const uint32 = (bytes: Uint8Array, offset: number): number => {
    if (offset < 0 || offset + 4 > bytes.byteLength) throw malformedFileError();
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  };

  if (input.byteLength > options.maxInputBytes || input.byteLength < 22) throw malformedFileError();
  let end = -1;
  for (let offset = input.byteLength - 22; offset >= Math.max(0, input.byteLength - 65_557); offset -= 1) {
    if (uint32(input, offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0 || uint16(input, end + 4) !== 0 || uint16(input, end + 6) !== 0) throw malformedFileError();
  const count = uint16(input, end + 10);
  const centralSize = uint32(input, end + 12);
  const centralOffset = uint32(input, end + 16);
  if (count > OOXML_LIMITS.maxEntries) throw structureLimitError();
  if (centralOffset + centralSize > end) throw malformedFileError();

  const files = new Map<string, Uint8Array>();
  let offset = centralOffset;
  let totalXmlSize = 0;
  let totalMediaSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (uint32(input, offset) !== 0x02014b50) throw malformedFileError();
    const flags = uint16(input, offset + 8);
    const compression = uint16(input, offset + 10);
    const compressedSize = uint32(input, offset + 20);
    const uncompressedSize = uint32(input, offset + 24);
    const nameLength = uint16(input, offset + 28);
    const extraLength = uint16(input, offset + 30);
    const commentLength = uint16(input, offset + 32);
    const localOffset = uint32(input, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || compression !== 0 && compression !== 8 || nextOffset > centralOffset + centralSize || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw malformedFileError();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(offset + 46, offset + 46 + nameLength));
    if (name === "" || name.includes("\\") || name.includes("..") || files.has(name)) throw malformedFileError();
    if (uint32(input, localOffset) !== 0x04034b50) throw malformedFileError();
    const dataOffset = localOffset + 30 + uint16(input, localOffset + 26) + uint16(input, localOffset + 28);
    if (dataOffset + compressedSize > input.byteLength) throw malformedFileError();
    const compressed = input.subarray(dataOffset, dataOffset + compressedSize);
    const inflate = (): Uint8Array => {
      const content = compression === 0 ? compressed.slice() : inflateSync(compressed, { out: new Uint8Array(uncompressedSize) });
      if (content.byteLength !== uncompressedSize) throw malformedFileError();
      return content;
    };
    if (isXmlPart(name)) {
      if (uncompressedSize > OOXML_LIMITS.maxXmlEntryBytes || totalXmlSize + uncompressedSize > OOXML_LIMITS.maxXmlTotalBytes) throw structureLimitError();
      totalXmlSize += uncompressedSize;
      files.set(name, inflate());
    } else if (isMediaPart(name) || options.keepOtherParts) {
      if (uncompressedSize > OOXML_LIMITS.maxMediaEntryBytes || totalMediaSize + uncompressedSize > OOXML_LIMITS.maxMediaTotalBytes) throw structureLimitError();
      totalMediaSize += uncompressedSize;
      files.set(name, inflate());
    } else {
      files.set(name, new Uint8Array(0));
    }
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw malformedFileError();
  return files;
}
