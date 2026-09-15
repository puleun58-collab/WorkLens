import type { NormalizedDocument, TableCell } from "@/domain/document";
import type { TextUnit } from "./types";

export function cellText(cell: TableCell): string {
  return cell.display.trim() || (cell.value === null ? "" : String(cell.value).trim());
}

export function isEmptyCell(cell: TableCell): boolean {
  return cell.display.trim() === "" && (cell.value === null || (typeof cell.value === "string" && cell.value.trim() === ""));
}

/** Flattens paragraphs and table cells into review units, keeping document order. */
export function collectTextUnits(document: NormalizedDocument): TextUnit[] {
  const units: TextUnit[] = [];
  for (const block of document.blocks) {
    if (block.type === "paragraph") {
      const text = block.text.trim();
      if (text) units.push({
        text,
        source: block.source,
        blockId: block.id,
        kind: "paragraph",
        order: units.length,
        ...(block.headingLevel ? { headingLevel: block.headingLevel } : {}),
        ...(block.source.page ? { page: block.source.page } : {}),
      });
      continue;
    }
    block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
      const text = cellText(cell);
      if (text) units.push({
        text,
        source: cell.source,
        blockId: block.id,
        kind: "cell",
        order: units.length,
        row: rowIndex + 1,
        column: columnIndex + 1,
        ...(cell.source.page ? { page: cell.source.page } : {}),
      });
    }));
  }
  return units;
}
