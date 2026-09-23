import { unzipOoxml } from "./ooxml-zip";
import { FORMAT_INPUT_LIMITS } from "./policy";

/**
 * Pictures placed *in* a cell ("Place in Cell") are not drawings: the cell
 * holds a rich value that points at a package image. ExcelJS reports such a
 * cell as `#VALUE!` and never surfaces the picture, so it is read here from
 * the rich-data parts. Only local images are followed; nothing external is
 * ever resolved.
 */
export interface CellImage {
  sheet: string;
  row: number;
  column: number;
  extension: string;
  data: Uint8Array;
}

const decode = (bytes: Uint8Array | undefined): string => bytes ? new TextDecoder("utf-8").decode(bytes) : "";

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1];

function relationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [tag] of xml.matchAll(/<Relationship\b[^>]*>/gu)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id && target && attribute(tag, "TargetMode") !== "External") map.set(id, target);
  }
  return map;
}

/** Resolves `../media/image1.png` relative to the part that referenced it. */
function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

const columnNumber = (letters: string): number =>
  letters.split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

export function readCellImages(bytes: Uint8Array): CellImage[] {
  let files: Map<string, Uint8Array>;
  try {
    files = unzipOoxml(bytes, {
      maxInputBytes: FORMAT_INPUT_LIMITS.xlsx,
      keepOtherParts: false,
      malformed: () => new Error("malformed"),
      limitExceeded: () => new Error("limit"),
    });
  } catch {
    // ExcelJS already admitted the package; a rich-data part it cannot read
    // only means there are no in-cell pictures to add.
    return [];
  }
  const richValues = decode(files.get("xl/richData/rdrichvalue.xml"));
  const metadata = decode(files.get("xl/metadata.xml"));
  if (!richValues || !metadata) return [];

  // Rich value structure: which key position holds the image relationship.
  const imageKeyIndex = [...decode(files.get("xl/richData/rdrichvaluestructure.xml")).matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/gu)]
    .map(([, body]) => [...body.matchAll(/<k\b[^>]*>/gu)].findIndex(([key]) => attribute(key, "n") === "_rvRel:LocalImageIdentifier"));
  const relIds = [...decode(files.get("xl/richData/richValueRel.xml")).matchAll(/<rel\b[^>]*>/gu)].map(([tag]) => attribute(tag, "r:id"));
  const relTargets = relationships(decode(files.get("xl/richData/_rels/richValueRel.xml.rels")));
  const rvImage = [...richValues.matchAll(/<rv\b([^>]*)>([\s\S]*?)<\/rv>/gu)].map(([, attributes, body]) => {
    const structure = Number(attribute(` ${attributes}`, "s") ?? "0");
    const keyIndex = imageKeyIndex[structure] ?? -1;
    if (keyIndex < 0) return undefined;
    const values = [...body.matchAll(/<v\b[^>]*>([^<]*)<\/v>/gu)].map(([, value]) => value);
    const relId = relIds[Number(values[keyIndex])];
    const target = relId ? relTargets.get(relId) : undefined;
    return target ? resolvePart("xl/richData/richValueRel.xml", target) : undefined;
  });

  // Cell `vm` → valueMetadata block → futureMetadata(XLRICHVALUE) block → rich value.
  const futureBlocks = /<futureMetadata\b[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/u.exec(metadata)?.[1] ?? "";
  const futureRv = [...futureBlocks.matchAll(/<bk>([\s\S]*?)<\/bk>/gu)].map(([, body]) => {
    const index = /<xlrd:rvb\b[^>]*\si="(\d+)"/u.exec(body)?.[1];
    return index === undefined ? undefined : Number(index);
  });
  const valueBlocks = /<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/u.exec(metadata)?.[1] ?? "";
  const vmRv = [...valueBlocks.matchAll(/<bk>([\s\S]*?)<\/bk>/gu)].map(([, body]) => {
    const record = /<rc\b[^>]*\sv="(\d+)"/u.exec(body)?.[1];
    return record === undefined ? undefined : futureRv[Number(record)];
  });

  const workbook = decode(files.get("xl/workbook.xml"));
  const workbookRels = relationships(decode(files.get("xl/_rels/workbook.xml.rels")));
  const images: CellImage[] = [];
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/gu)) {
    const name = attribute(tag, "name");
    const target = workbookRels.get(attribute(tag, "r:id") ?? "");
    if (!name || !target) continue;
    const sheetXml = decode(files.get(resolvePart("xl/workbook.xml", target)));
    for (const [cell] of sheetXml.matchAll(/<c\b[^>]*\svm="\d+"[^>]*>/gu)) {
      const address = /^([A-Z]+)(\d+)$/u.exec(attribute(cell, "r") ?? "");
      const rv = vmRv[Number(attribute(cell, "vm")) - 1];
      const part = rv === undefined ? undefined : rvImage[rv];
      const data = part ? files.get(part) : undefined;
      if (!address || !part || !data || data.byteLength === 0) continue;
      const decodedName = name.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&apos;/gu, "'");
      images.push({
        sheet: decodedName,
        row: Number(address[2]),
        column: columnNumber(address[1]),
        extension: part.split(".").pop()?.toLowerCase() ?? "png",
        data,
      });
    }
  }
  return images;
}
