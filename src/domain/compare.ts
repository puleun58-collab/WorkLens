import type {
  DocumentBlock,
  NormalizedDocument,
  SourceRef,
  TableBlock,
  TableCell,
} from "./document";
import { parseCanonicalNumber } from "./numeric";

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

const numericValue = (cell: TableCell): number | undefined => {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return cell.value;
  }
  return parseCanonicalNumber(cellText(cell))?.value;
};

/**
 * Longest-common-subsequence alignment over normalized text.
 *
 * Positional pairing turns a single insertion into a cascade of false `Changed`
 * rows plus a trailing `Added`; aligning first keeps unchanged content unchanged.
 */
const alignByText = <T>(
  base: readonly T[],
  current: readonly T[],
  text: (item: T) => string,
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
  return pairUnmatchedNeighbors(pairs);
};

/**
 * LCS reports an edited item as a delete followed by an insert. A run of one
 * unmatched base and one unmatched current is really a modification, so pair
 * them back up; longer or unbalanced runs stay genuine Removed/Added.
 */
const pairUnmatchedNeighbors = <T>(
  pairs: Array<{ base?: T; current?: T }>,
): Array<{ base?: T; current?: T }> => {
  const merged: Array<{ base?: T; current?: T }> = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const next = pairs[index + 1];
    const isLoneRemoval = pair.base !== undefined && pair.current === undefined;
    const isLoneAddition = next?.base === undefined && next?.current !== undefined;
    const followedByMatch = pairs[index + 2]?.base !== undefined && pairs[index + 2]?.current !== undefined;

    if (isLoneRemoval && isLoneAddition && (index + 2 >= pairs.length || followedByMatch)) {
      merged.push({ base: pair.base, current: next.current });
      index += 1;
      continue;
    }
    merged.push(pair);
  }
  return merged;
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
      label: `${tableLabel(current)} columns`,
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
      label: `${tableLabel(current)}: ambiguous duplicate key ${key}`,
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
        label: `${tableLabel(current)}: ${key}`,
        current: key,
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
          label: `${tableLabel(current)}: ${key}, merge geometry`,
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
          label: `${tableLabel(current)}: ${key}, column ${index + 1}`,
          previous,
          current: next,
          sources: {
            base: previousCell?.source,
            current: currentCell?.source,
          },
        });
        continue;
      }

      const previousNumber = numericValue(previousCell);
      const currentNumber = numericValue(currentCell);
      const common = {
        label: `${tableLabel(current)}: ${key}, column ${index + 1}`,
        previous,
        current: next,
        sources: { base: previousCell.source, current: currentCell.source },
      };

      if (previousNumber !== undefined && currentNumber !== undefined) {
        const difference = currentNumber - previousNumber;
        const changePercent =
          previousNumber === 0 ? null : (difference / previousNumber) * 100;
        results.push(
          difference === 0
            ? { category: "Changed", ...common, difference, changePercent }
            : { category: "Important Change", ...common, difference, changePercent },
        );
      } else {
        results.push({
          category: "Changed",
          ...common,
          difference: null,
          changePercent: null,
        });
      }
    }
  }

  for (const [key, baseRow] of baseRows) {
    if (!currentRows.has(key)) {
      results.push({
        category: "Removed",
        label: `${tableLabel(base)}: ${key}`,
        previous: key,
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
        previous: "Table removed",
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
      current: "Table added",
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
        previous: "Table removed",
        sources: { base: pair.base.source },
      });
    } else if (pair.current !== undefined) {
      results.push({
        category: "Added",
        label: tableLabel(pair.current),
        current: "Table added",
        sources: { current: pair.current.source },
      });
    }
  }

  const alignedText = alignByText(textBlocks(base), textBlocks(current), blockText);
  alignedText.forEach((pair, index) => {
    const previousBlock = pair.base;
    const currentBlock = pair.current;
    const previous = previousBlock === undefined ? "" : blockText(previousBlock);
    const next = currentBlock === undefined ? "" : blockText(currentBlock);
    if (previous === next) return;

    if (previousBlock === undefined && currentBlock !== undefined) {
      results.push({
        category: "Added",
        label: `Text ${index + 1}`,
        current: next,
        sources: { current: blockSource(currentBlock) },
      });
    } else if (previousBlock !== undefined && currentBlock === undefined) {
      results.push({
        category: "Removed",
        label: `Text ${index + 1}`,
        previous,
        sources: { base: blockSource(previousBlock) },
      });
    } else if (previousBlock !== undefined && currentBlock !== undefined) {
      results.push({
        category: "Changed",
        label: `Text ${index + 1}`,
        previous,
        current: next,
        difference: null,
        changePercent: null,
        sources: {
          base: blockSource(previousBlock),
          current: blockSource(currentBlock),
        },
      });
    }
  });

  return results;
};
