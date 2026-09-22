/**
 * Workbook value semantics shared by the parser and every exporter.
 *
 * Excel stores a calendar day and an ordinary count as the same number, so the
 * number format — never the magnitude — decides whether a serial is a date.
 */
export const DATE_NUMBER_FORMAT = "yyyy.mm.dd";
export const DATETIME_NUMBER_FORMAT = "yyyy.mm.dd hh:mm";

const EXCEL_EPOCH_DAYS = 25_569;
const MAX_EXCEL_SERIAL = 2_958_465;

export function isDateNumberFormat(format: string | undefined): boolean {
  if (!format) return false;
  const tokens = format.replace(/\\./gu, "").replace(/"[^"]*"/gu, "").replace(/\[[^\]]*\]/gu, "");
  return /[ymdhs]/iu.test(tokens);
}

export function serialToDate(serial: number): Date | undefined {
  if (!Number.isFinite(serial) || serial <= 0 || serial > MAX_EXCEL_SERIAL) return undefined;
  return new Date(Math.round((serial - EXCEL_EPOCH_DAYS) * 86_400_000));
}

/** Pixel size read from the image header, so embedded pictures keep their ratio. */
export function imagePixelSize(bytes: Uint8Array, extension: string): { width: number; height: number } | undefined {
  const kind = extension.toLowerCase();
  if (kind === "png" && bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (kind === "gif" && bytes.byteLength >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (kind === "jpg" || kind === "jpeg") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset += 1; continue; }
      const marker = view.getUint8(offset + 1);
      const length = view.getUint16(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      if (length < 2) return undefined;
      offset += 2 + length;
    }
  }
  return undefined;
}
