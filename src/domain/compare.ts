import type {
  DocumentBlock,
  NormalizedDocument,
  SourceRef,
  TableBlock,
  TableCell,
} from "./document";
import { parseCanonicalNumber } from "./numeric";
import type { Measure } from "./measure";
import { measureDelta, numberSkeleton, parseMeasure, sentenceDelta } from "./measure";

export type ComparisonCategory =
  | "Added"
  | "Removed"
  | "Changed"
  | "Structural Change"
  | "Important Change";

export interface ComparisonSources {
  base?: SourceRef;
  current?: SourceRef;
}

interface ComparisonBase {
  category: ComparisonCategory;
  label: string;
  sources: ComparisonSources;
}

export interface Added extends ComparisonBase {
  category: "Added";
  current: string;
}

export interface Removed extends ComparisonBase {
  category: "Removed";
  previous: string;
}

export interface Changed extends ComparisonBase {
  category: "Changed";
  previous: string;
  current: string;
  difference?: number | null;
  changePercent?: number | null;
  /** The difference as the reader sees it, unit included. */
  deltaText?: string | null;
}

export interface StructuralChange extends ComparisonBase {
  category: "Structural Change";
  previous: string;
  current: string;
}

export interface ImportantChange extends ComparisonBase {
  category: "Important Change";
  previous: string;
  current: string;
  difference: number;
  changePercent: number | null;
  deltaText: string;
}

export type Comparison =
  | Added
  | Removed
  | Changed
  | StructuralChange
  | ImportantChange;

export interface ComparisonItem {
  id: string;
  category: ComparisonCategory;
  label: string;
  previous: string | null;
  current: string | null;
  difference: number | null;
  changePercent: number | null;
  deltaText: string | null;
  sources: SourceRef[];
}

export interface ComparisonSummary {
  total: number;
  added: number;
  removed: number;
  changed: number;
  structural: number;
  important: number;
}

export interface ComparisonResult {
  summary: ComparisonSummary;
  items: ComparisonItem[];
}

interface KeyedRow {
  key: string;
  cells: TableCell[];
}

const cellText = (cell: TableCell): string => cell.display.trim();
/** An added/removed row is reported with all of its content, not just its key cell. */
const rowText = (cells: readonly TableCell[]): string => cells.map(cellText).filter(Boolean).join(" · ");

const rowKey = (cells: TableCell[]): string | undefined => {
  const first = cells.find((cell) => cellText(cell) !== "");
  return first === undefined ? undefined : cellText(first);
};

const keyedRows = (table: TableBlock): KeyedRow[] =>
  table.rows.flatMap((cells) => {
    const key = rowKey(cells);
    return key === undefined ? [] : [{ key, cells }];
  });

const tableIdentity = (table: TableBlock, position: number): string =>
  table.source.sheet === undefined
    ? `table:${position}`
    : `sheet:${table.source.sheet}`;

/**
 * Row-key signature for tables without a sheet name. Stable when cell values
 * change (so edits still compare cell-by-cell) but distinct when rows are
 * inserted or removed (so an inserted table aligns as Added).
 */
const tableSignature = (table: TableBlock): string =>
  keyedRows(table)
    .map((row) => row.key)
    .join("\u0000");

const tableBlocks = (document: NormalizedDocument): TableBlock[] =>
  document.blocks.filter(
    (block): block is TableBlock => block.type === "table",
  );

const textBlocks = (document: NormalizedDocument): DocumentBlock[] =>
  document.blocks.filter((block) => block.type !== "table");

const blockText = (block: DocumentBlock): string =>
  block.type === "paragraph" ? block.text.trim().replace(/\s+/g, " ") : "";

const blockSource = (block: DocumentBlock): SourceRef => block.source;

const tableLabel = (table: TableBlock): string =>
  table.source.sheet === undefined ? table.source.label : table.source.sheet;

/**
 * A cell is a measurement only when its own type says so. A date cell and a
 * code cell both hold digits and neither has a difference worth computing.
 * Written numerals must also survive the canonical parser, which refuses
 * readings like `1,234` that could be either grouping or a decimal mark.
 */
const cellMeasure = (cell: TableCell): Measure | undefined => {
  if (cell.valueType === "date") return undefined;
  const text = cellText(cell);
  const written = parseMeasure(text);
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return written ?? { value: cell.value, unit: "", kind: "plain", prefixed: false, numberText: text };
  }
  return written && parseCanonicalNumber(written.numberText) !== undefined ? written : undefined;
};

/**
 * The item name a reader recognises: the row's own key and, when the table
 * carries one, its column heading. Internal block names never surface.
 */
const headerRows = new WeakMap<TableBlock, string[]>();
const headerRowOf = (table: TableBlock): string[] => {
  const cached = headerRows.get(table);
  if (cached) return cached;
  const labels = (table.rows[0] ?? []).map(cellText);
  const resolved = labels.filter(Boolean).length >= 2 ? labels : [];
  headerRows.set(table, resolved);
  return resolved;
};
const columnLabel = (table: TableBlock, key: string, index: number): string => {
  const header = headerRowOf(table)[index] ?? "";
  return header && header !== key ? `${key} · ${header}` : key;
};

/** `담당부서: 인재개발팀` is a named item, not one sentence. */
const LABELLED_TEXT = /^([^:：]{1,24})\s*[:：]\s*(.+)$/u;
const labelledText = (text: string): { label: string; value: string } | undefined => {
  const match = LABELLED_TEXT.exec(text.trim());
  if (!match) return undefined;
  const label = match[1].trim();
  const value = match[2].trim();
  return label && value && !/\d{1,2}$/u.test(label) ? { label, value } : undefined;
};
/**
 * Longest-common-subsequence alignment over normalized text.
 *
 * Positional pairing turns a single insertion into a cascade of false `Changed`
 * rows plus a trailing `Added`; aligning first keeps unchanged content unchanged.
 * A caller may conservatively pair edited neighbors inside one unmatched run.
 */
const alignByText = <T>(
  base: readonly T[],
  current: readonly T[],
  text: (item: T) => string,
  compatible?: (base: T, current: T) => boolean,
): Array<{ base?: T; current?: T }> => {
  const rows = base.length;
  const columns = current.length;
  if (rows * columns > 1_000_000) throw new Error("COMPARE_ALIGNMENT_LIMIT");
  const baseKeys = base.map(text);
  const currentKeys = current.map(text);
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row][column] =
        baseKeys[row] === currentKeys[column]
          ? lengths[row + 1][column + 1] + 1
          : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
    }
  }

  const pairs: Array<{ base?: T; current?: T }> = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (baseKeys[row] === currentKeys[column]) {
      pairs.push({ base: base[row], current: current[column] });
      row += 1;
      column += 1;
    } else if (lengths[row + 1][column] >= lengths[row][column + 1]) {
      pairs.push({ base: base[row] });
      row += 1;
    } else {
      pairs.push({ current: current[column] });
      column += 1;
    }
  }
  while (row < rows) {
    pairs.push({ base: base[row] });
    row += 1;
  }
  while (column < columns) {
    pairs.push({ current: current[column] });
    column += 1;
  }
  return pairUnmatchedRuns(pairs, compatible);
};

/**
 * Re-aligns an unmatched run only with a caller-provided, local compatibility
 * rule. The dynamic program preserves source order and leaves incompatible
 * blocks as Removed/Added instead of forcing a fuzzy pair.
 */
const pairUnmatchedRuns = <T>(
  pairs: Array<{ base?: T; current?: T }>,
  compatible?: (base: T, current: T) => boolean,
): Array<{ base?: T; current?: T }> => {
  const merged: Array<{ base?: T; current?: T }> = [];
  let index = 0;
  while (index < pairs.length) {
    if (pairs[index].base !== undefined && pairs[index].current !== undefined) {
      merged.push(pairs[index]);
      index += 1;
      continue;
    }
    const run: Array<{ base?: T; current?: T }> = [];
    while (
      index < pairs.length &&
      !(pairs[index].base !== undefined && pairs[index].current !== undefined)
    ) {
      run.push(pairs[index]);
      index += 1;
    }
    const removed = run.flatMap((pair) => pair.base === undefined ? [] : [pair.base]);
    const added = run.flatMap((pair) => pair.current === undefined ? [] : [pair.current]);
    if (!compatible) {
      if (removed.length === 1 && added.length === 1) {
        merged.push({ base: removed[0], current: added[0] });
      } else {
        merged.push(...run);
      }
      continue;
    }

    const scores: number[][] = Array.from({ length: removed.length + 1 }, () =>
      new Array<number>(added.length + 1).fill(0),
    );
    for (let row = removed.length - 1; row >= 0; row -= 1) {
      for (let column = added.length - 1; column >= 0; column -= 1) {
        scores[row][column] = compatible(removed[row], added[column])
          ? scores[row + 1][column + 1] + 1
          : Math.max(scores[row + 1][column], scores[row][column + 1]);
      }
    }
    let row = 0;
    let column = 0;
    while (row < removed.length && column < added.length) {
      if (
        compatible(removed[row], added[column]) &&
        scores[row][column] === scores[row + 1][column + 1] + 1
      ) {
        merged.push({ base: removed[row], current: added[column] });
        row += 1;
        column += 1;
      } else if (scores[row + 1][column] >= scores[row][column + 1]) {
        merged.push({ base: removed[row] });
        row += 1;
      } else {
        merged.push({ current: added[column] });
        column += 1;
      }
    }
    while (row < removed.length) {
      merged.push({ base: removed[row] });
      row += 1;
    }
    while (column < added.length) {
      merged.push({ current: added[column] });
      column += 1;
    }
  }
  return merged;
};

const structuralLocation = (source: SourceRef): string | undefined => {
  const locator = source.locator;
  if (!locator) return undefined;
  switch (locator.kind) {
    case "pptx":
      return `pptx:${locator.slide}:${locator.shape}:${locator.tableCell?.row ?? ""}:${locator.tableCell?.column ?? ""}`;
    case "docx":
      return `docx:${locator.part}:${locator.block}:${locator.tableCell?.row ?? ""}:${locator.tableCell?.column ?? ""}`;
    case "pdf":
      return `pdf:${locator.page}`;
    case "xlsx":
      return `xlsx:${locator.sheet}:${locator.range}`;
    case "csv":
      return `csv:${locator.record}:${locator.column}`;
  }
};

const structuralRegion = (source: SourceRef): string | undefined => {
  const locator = source.locator;
  if (!locator) return undefined;
  switch (locator.kind) {
    case "pptx": return `pptx:${locator.slide}`;
    case "docx": return `docx:${locator.part}`;
    case "pdf": return `pdf:${locator.page}`;
    case "xlsx": return `xlsx:${locator.sheet}`;
    case "csv": return "csv";
  }
};


const textBigrams = (value: string): Set<string> => {
  const compact = value.toLocaleLowerCase().replace(/[\s\d,.\-+%]/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
};

const textSimilarity = (left: string, right: string): number => {
  if (numberSkeleton(left) === numberSkeleton(right)) return 1;
  const a = textBigrams(left);
  const b = textBigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
};

const compatibleTextBlocks = (base: DocumentBlock, current: DocumentBlock): boolean => {
  const baseLocation = structuralLocation(blockSource(base));
  const currentLocation = structuralLocation(blockSource(current));
  const sameLocation = baseLocation !== undefined && baseLocation === currentLocation;
  const sameRegion =
    structuralRegion(blockSource(base)) !== undefined &&
    structuralRegion(blockSource(base)) === structuralRegion(blockSource(current));
  if (!sameLocation && !sameRegion) return false;
  const similarity = textSimilarity(blockText(base), blockText(current));
  return similarity >= (sameLocation ? 0.45 : 0.62);
};

const compareTable = (
  base: TableBlock,
  current: TableBlock,
  results: Comparison[],
): void => {
  const logicalWidth = (row: TableCell[]): number =>
    row.reduce((maximum, cell, index) => {
      const column = cell.source.column ?? index + 1;
      return Math.max(maximum, column + (cell.colSpan ?? 1) - 1);
    }, 0);
  const baseColumnCount = Math.max(0, ...base.rows.map(logicalWidth));
  const currentColumnCount = Math.max(0, ...current.rows.map(logicalWidth));

  if (baseColumnCount !== currentColumnCount) {
    results.push({
      category: "Structural Change",
      label: "열 수",
      previous: String(baseColumnCount),
      current: String(currentColumnCount),
      sources: { base: base.source, current: current.source },
    });
  }

  const groupRows = (table: TableBlock) => {
    const groups = new Map<string, ReturnType<typeof keyedRows>>();
    for (const row of keyedRows(table)) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
    return groups;
  };
  const baseGroups = groupRows(base);
  const currentGroups = groupRows(current);
  const ambiguous = new Set(
    [...new Set([...baseGroups.keys(), ...currentGroups.keys()])].filter(
      (key) => (baseGroups.get(key)?.length ?? 0) > 1 || (currentGroups.get(key)?.length ?? 0) > 1,
    ),
  );
  for (const key of ambiguous) {
    results.push({
      category: "Structural Change",
      label: `${key} · 중복 행`,
      previous: String(baseGroups.get(key)?.length ?? 0),
      current: String(currentGroups.get(key)?.length ?? 0),
      sources: {
        base: baseGroups.get(key)?.[0]?.cells[0]?.source ?? base.source,
        current: currentGroups.get(key)?.[0]?.cells[0]?.source ?? current.source,
      },
    });
  }
  const baseRows = new Map(
    [...baseGroups].filter(([key, rows]) => !ambiguous.has(key) && rows.length === 1).map(([key, rows]) => [key, rows[0]]),
  );
  const currentRows = new Map(
    [...currentGroups].filter(([key, rows]) => !ambiguous.has(key) && rows.length === 1).map(([key, rows]) => [key, rows[0]]),
  );

  for (const [key, currentRow] of currentRows) {
    const baseRow = baseRows.get(key);
    if (baseRow === undefined) {
      results.push({
        category: "Added",
        label: key,
        current: rowText(currentRow.cells) || key,
        sources: { current: currentRow.cells[0]?.source ?? current.source },
      });
      continue;
    }

    const columns = Math.max(baseRow.cells.length, currentRow.cells.length);
    for (let index = 0; index < columns; index += 1) {
      const previousCell = baseRow.cells[index];
      const currentCell = currentRow.cells[index];
      const previous = previousCell === undefined ? "" : cellText(previousCell);
      const next = currentCell === undefined ? "" : cellText(currentCell);
      if (
        previousCell !== undefined &&
        currentCell !== undefined &&
        ((previousCell.rowSpan ?? 1) !== (currentCell.rowSpan ?? 1) ||
          (previousCell.colSpan ?? 1) !== (currentCell.colSpan ?? 1))
      ) {
        results.push({
          category: "Structural Change",
          label: `${key} · 셀 병합`,
          previous: `${previousCell.rowSpan ?? 1}x${previousCell.colSpan ?? 1}`,
          current: `${currentCell.rowSpan ?? 1}x${currentCell.colSpan ?? 1}`,
          sources: { base: previousCell.source, current: currentCell.source },
        });
      }
      if (previous === next) {
        continue;
      }

      if (previousCell === undefined || currentCell === undefined) {
        results.push({
          category: "Structural Change",
          label: columnLabel(current, key, index),
          previous,
          current: next,
          sources: {
            base: previousCell?.source,
            current: currentCell?.source,
          },
        });
        continue;
      }

      const delta = measureDelta(cellMeasure(previousCell), cellMeasure(currentCell));
      const common = {
        label: columnLabel(current, key, index),
        previous,
        current: next,
        sources: { base: previousCell.source, current: currentCell.source },
      };

      if (delta) {
        results.push(
          delta.difference === 0
            ? { category: "Changed", ...common, difference: delta.difference, changePercent: delta.changePercent, deltaText: delta.text }
            : { category: "Important Change", ...common, difference: delta.difference, changePercent: delta.changePercent, deltaText: delta.text },
        );
      } else {
        results.push({
          category: "Changed",
          ...common,
          difference: null,
          changePercent: null,
          deltaText: null,
        });
      }
    }
  }

  for (const [key, baseRow] of baseRows) {
    if (!currentRows.has(key)) {
      results.push({
        category: "Removed",
        label: key,
        previous: rowText(baseRow.cells) || key,
        sources: { base: baseRow.cells[0]?.source ?? base.source },
      });
    }
  }
};

export const buildComparison = (
  base: NormalizedDocument,
  current: NormalizedDocument,
): ComparisonResult => {
  const comparisons = compareDocuments(base, current);
  const summary: ComparisonSummary = {
    total: comparisons.length,
    added: comparisons.filter((item) => item.category === "Added").length,
    removed: comparisons.filter((item) => item.category === "Removed").length,
    changed: comparisons.filter((item) => item.category === "Changed").length,
    structural: comparisons.filter((item) => item.category === "Structural Change").length,
    important: comparisons.filter((item) => item.category === "Important Change").length,
  };
  const items = comparisons.map((comparison, index): ComparisonItem => {
    const sources = [comparison.sources.base, comparison.sources.current].filter(
      (source): source is SourceRef => source !== undefined,
    );
    return {
      id: `change:${index + 1}`,
      category: comparison.category,
      label: comparison.label,
      previous: "previous" in comparison ? comparison.previous : null,
      current: "current" in comparison ? comparison.current : null,
      difference: "difference" in comparison ? comparison.difference ?? null : null,
      changePercent: "changePercent" in comparison ? comparison.changePercent ?? null : null,
      deltaText: "deltaText" in comparison ? comparison.deltaText ?? null : null,
      sources,
    };
  });
  return { summary, items };
};

export const compareDocuments = (
  base: NormalizedDocument,
  current: NormalizedDocument,
): Comparison[] => {
  const results: Comparison[] = [];
  const baseTables = tableBlocks(base);
  const currentTables = tableBlocks(current);

  // Sheet-named tables have stable identity. Unnamed DOCX/PPTX tables do not, so
  // they are aligned by content signature; positional pairing would compare an
  // inserted table against the wrong predecessor and shift every later table.
  const named = (table: TableBlock): boolean => table.source.sheet !== undefined;
  const currentByIdentity = new Map(
    currentTables.filter(named).map((table, index) => [tableIdentity(table, index), table]),
  );

  for (const [index, baseTable] of baseTables.filter(named).entries()) {
    const identity = tableIdentity(baseTable, index);
    const currentTable = currentByIdentity.get(identity);
    if (currentTable === undefined) {
      results.push({
        category: "Removed",
        label: tableLabel(baseTable),
        previous: "표 삭제",
        sources: { base: baseTable.source },
      });
      continue;
    }
    compareTable(baseTable, currentTable, results);
    currentByIdentity.delete(identity);
  }

  for (const currentTable of currentByIdentity.values()) {
    results.push({
      category: "Added",
      label: tableLabel(currentTable),
      current: "표 추가",
      sources: { current: currentTable.source },
    });
  }

  const baseUnnamed = baseTables.filter((table) => !named(table));
  const currentUnnamed = currentTables.filter((table) => !named(table));
  const signatureCounts = (tables: TableBlock[]) => {
    const counts = new Map<string, number>();
    for (const table of tables) counts.set(tableSignature(table), (counts.get(tableSignature(table)) ?? 0) + 1);
    return counts;
  };
  const baseSignatureCounts = signatureCounts(baseUnnamed);
  const currentSignatureCounts = signatureCounts(currentUnnamed);
  const ambiguousSignatures = new Set(
    [...new Set([...baseSignatureCounts.keys(), ...currentSignatureCounts.keys()])].filter(
      (signature) => (baseSignatureCounts.get(signature) ?? 0) > 1 || (currentSignatureCounts.get(signature) ?? 0) > 1,
    ),
  );
  for (const signature of ambiguousSignatures) {
    const baseTable = baseUnnamed.find((table) => tableSignature(table) === signature);
    const currentTable = currentUnnamed.find((table) => tableSignature(table) === signature);
    results.push({
      category: "Structural Change",
      label: "Ambiguous duplicate table structure",
      previous: String(baseSignatureCounts.get(signature) ?? 0),
      current: String(currentSignatureCounts.get(signature) ?? 0),
      sources: { base: baseTable?.source, current: currentTable?.source },
    });
  }
  const alignedTables = alignByText(
    baseUnnamed.filter((table) => !ambiguousSignatures.has(tableSignature(table))),
    currentUnnamed.filter((table) => !ambiguousSignatures.has(tableSignature(table))),
    tableSignature,
  );
  for (const pair of alignedTables) {
    if (pair.base !== undefined && pair.current !== undefined) {
      compareTable(pair.base, pair.current, results);
    } else if (pair.base !== undefined) {
      results.push({
        category: "Removed",
        label: tableLabel(pair.base),
        previous: "표 삭제",
        sources: { base: pair.base.source },
      });
    } else if (pair.current !== undefined) {
      results.push({
        category: "Added",
        label: tableLabel(pair.current),
        current: "표 추가",
        sources: { current: pair.current.source },
      });
    }
  }

  const alignedText = alignByText(
    textBlocks(base),
    textBlocks(current),
    blockText,
    compatibleTextBlocks,
  );
  alignedText.forEach((pair) => {
    const previousBlock = pair.base;
    const currentBlock = pair.current;
    const previousText = previousBlock === undefined ? "" : blockText(previousBlock);
    const currentText = currentBlock === undefined ? "" : blockText(currentBlock);
    if (previousText === currentText) return;
    const previousPair = labelledText(previousText);
    const currentPair = labelledText(currentText);
    // "담당부서: 인재개발팀" names its own item; the label becomes the item and
    // the value becomes what changed.
    const paired = previousBlock !== undefined && currentBlock !== undefined
      && previousPair !== undefined && currentPair !== undefined
      && previousPair.label === currentPair.label;
    const label = paired ? previousPair.label : previousBlock === undefined ? currentPair?.label ?? "" : previousPair?.label ?? "";
    const previous = paired ? previousPair.value : previousPair && previousBlock !== undefined && currentBlock === undefined ? previousPair.value : previousText;
    const next = paired ? currentPair.value : currentPair && currentBlock !== undefined && previousBlock === undefined ? currentPair.value : currentText;

    if (previousBlock === undefined && currentBlock !== undefined) {
      results.push({
        category: "Added",
        label,
        current: next,
        sources: { current: blockSource(currentBlock) },
      });
    } else if (previousBlock !== undefined && currentBlock === undefined) {
      results.push({
        category: "Removed",
        label,
        previous,
        sources: { base: blockSource(previousBlock) },
      });
    } else if (previousBlock !== undefined && currentBlock !== undefined) {
      const delta = sentenceDelta(previous, next);
      const common = {
        label,
        previous,
        current: next,
        sources: {
          base: blockSource(previousBlock),
          current: blockSource(currentBlock),
        },
      };
      if (delta && delta.difference !== 0) {
        results.push({
          category: "Important Change",
          ...common,
          difference: delta.difference,
          changePercent: delta.changePercent,
          deltaText: delta.text,
        });
      } else {
        results.push({
          category: "Changed",
          ...common,
          difference: delta?.difference ?? null,
          changePercent: delta?.changePercent ?? null,
          deltaText: delta?.text ?? null,
        });
      }
    }
  });

  return results;
};
