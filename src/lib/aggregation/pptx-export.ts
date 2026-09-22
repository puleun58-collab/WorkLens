import { strToU8, zipSync } from "fflate";
import type { AggregationDraft, AggregationRecord, AggregationSelection } from "@/domain/aggregation";
import type { DocumentMedia, NormalizedDocument } from "@/domain/document";
import { improvementProfileStatus, improvementValue } from "@/lib/aggregation/improvement-profile";
import type { ImprovementExport } from "@/lib/aggregation/improvement-export";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const EMU = 914400;
const WIDTH = 10261600;
const HEIGHT = 7218363;

function escapeXml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function selectedRecords(draft: AggregationDraft, selection: AggregationSelection): AggregationRecord[] {
  const sheetIds = new Set(selection.sheetIds);
  return draft.records.filter((record) => sheetIds.has(record.sheetId));
}

function textShape(id: number, name: string, text: unknown, x: number, y: number, w: number, h: number, size: number, bold = false, color = "1F2937"): string {
  const paragraphs = String(text ?? "").split(/\r?\n/).map((line) => `<a:p><a:r><a:rPr lang="ko-KR" sz="${size * 100}"${bold ? " b=\"1\"" : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/></a:rPr><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="ko-KR" sz="${size * 100}"/></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function picture(id: number, rid: number, media: DocumentMedia, x: number, y: number, w: number, h: number): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(media.source.label || `Image ${id}`)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function slideXml(record: AggregationRecord, media: DocumentMedia[], index: number): string {
  const department = improvementValue(record, "department");
  const title = improvementValue(record, "title") ?? improvementValue(record, "managementNo") ?? "";
  const start = improvementValue(record, "registeredAt");
  const end = improvementValue(record, "closedAt");
  const period = improvementValue(record, "period") ?? [start, end].filter((value) => value !== null).join(" ~ ");
  const current = improvementValue(record, "current");
  const result = improvementValue(record, "result");
  const effect = improvementValue(record, "effect");
  const imageWidth = media.length > 1 ? Math.floor(4.2 * EMU) : Math.floor(8.65 * EMU);
  const imageShapes = media.slice(0, 2).map((item, mediaIndex) => picture(20 + mediaIndex, 2 + mediaIndex, item, Math.floor((0.72 + mediaIndex * 4.45) * EMU), Math.floor(2.0 * EMU), imageWidth, Math.floor(2.25 * EMU))).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7F8FA"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${textShape(2, "Department", department, Math.floor(.7*EMU), Math.floor(.35*EMU), Math.floor(2.2*EMU), Math.floor(.45*EMU), 18, true, "1F4E78")}${textShape(3, "Title", title, Math.floor(.7*EMU), Math.floor(.78*EMU), Math.floor(8.6*EMU), Math.floor(.65*EMU), 25, true)}${textShape(4, "Period", period, Math.floor(.7*EMU), Math.floor(1.42*EMU), Math.floor(8.6*EMU), Math.floor(.35*EMU), 11, false, "64748B")}${imageShapes}${textShape(5, "Current label", media.length ? "문제점" : "점검내용", Math.floor(.7*EMU), Math.floor((media.length ? 4.48 : 2.05)*EMU), Math.floor(1.25*EMU), Math.floor(.35*EMU), 14, true, "1F4E78")}${textShape(6, "Current", current, Math.floor(2.0*EMU), Math.floor((media.length ? 4.42 : 1.98)*EMU), Math.floor(7.0*EMU), Math.floor(1.0*EMU), 13)}${textShape(7, "Result label", "개선내용", Math.floor(.7*EMU), Math.floor((media.length ? 5.48 : 3.2)*EMU), Math.floor(1.25*EMU), Math.floor(.35*EMU), 14, true, "1F4E78")}${textShape(8, "Result", result, Math.floor(2.0*EMU), Math.floor((media.length ? 5.42 : 3.13)*EMU), Math.floor(7.0*EMU), Math.floor(1.0*EMU), 13)}${effect ? textShape(9, "Effect label", "개선효과", Math.floor(.7*EMU), Math.floor(6.45*EMU), Math.floor(1.25*EMU), Math.floor(.3*EMU), 13, true, "1F4E78") + textShape(10, "Effect", effect, Math.floor(2.0*EMU), Math.floor(6.4*EMU), Math.floor(7*EMU), Math.floor(.45*EMU), 12) : ""}${textShape(11, "Page", index, Math.floor(9.65*EMU), Math.floor(7.25*EMU), Math.floor(.5*EMU), Math.floor(.25*EMU), 9, false, "94A3B8")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function coverXml(count: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F4E78"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="2560320"/><a:ext cx="8960800" cy="1280160"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ko-KR" sz="3200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ea typeface="맑은 고딕"/></a:rPr><a:t>개선제안 Backdata</a:t></a:r></a:p><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ko-KR" sz="1200"><a:solidFill><a:srgbClr val="D9EAF7"/></a:solidFill></a:rPr><a:t>${count}건</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideRelationships(media: DocumentMedia[]): string {
  const images = media.slice(0, 2).map((item, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${escapeXml(item.id.replace(/[^a-zA-Z0-9_.-]/g, "_"))}.${escapeXml(item.extension)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${images}</Relationships>`;
}

export function improvementBackdataExport(draft: AggregationDraft, selection: AggregationSelection, documents: readonly NormalizedDocument[]): ImprovementExport {
  const records = selectedRecords(draft, selection);
  const status = improvementProfileStatus(records);
  if (!status.available) throw new Error(`개선 프로필 필수 항목이 없습니다: ${status.missing.join(", ")}`);
  const mediaById = new Map(documents.flatMap((document) => document.media ?? []).map((media) => [media.id, media]));
  const recordMedia = records.map((record) => record.media.map((ref) => mediaById.get(ref.id)).filter((media): media is DocumentMedia => Boolean(media)));
  const slideCount = records.length + 1;
  const files: Record<string, Uint8Array> = {};
  const xmlFile = (name: string, content: string) => { files[name] = strToU8(content); };
  const defaults = ["png", "jpeg", "jpg", "gif"].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpg" ? "jpeg" : ext}"/>`).join("");
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  xmlFile("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`);
  xmlFile("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  xmlFile("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${WIDTH}" cy="${HEIGHT}" type="custom"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  xmlFile("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
  xmlFile("ppt/slides/slide1.xml", coverXml(records.length));
  xmlFile("ppt/slides/_rels/slide1.xml.rels", slideRelationships([]));
  records.forEach((record, index) => {
    const slide = index + 2;
    xmlFile(`ppt/slides/slide${slide}.xml`, slideXml(record, recordMedia[index], slide));
    xmlFile(`ppt/slides/_rels/slide${slide}.xml.rels`, slideRelationships(recordMedia[index]));
    for (const media of recordMedia[index].slice(0, 2)) files[`ppt/media/${media.id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.${media.extension}`] = media.data;
  });
  xmlFile("ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  xmlFile("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  xmlFile("ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  xmlFile("ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  xmlFile("ppt/theme/theme1.xml", `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="WorkLens"><a:themeElements><a:clrScheme name="WorkLens"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F4E78"/></a:dk2><a:lt2><a:srgbClr val="F7F8FA"/></a:lt2>${["4472C4","70AD47","ED7D31","A5A5A5","5B9BD5","FFC000"].map((color, i) => `<a:accent${i + 1}><a:srgbClr val="${color}"/></a:accent${i + 1}>`).join("")}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="WorkLens"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="맑은 고딕"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="WorkLens"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  return { fileName: "worklens-improvement-backdata.pptx", mimeType: PPTX_MIME, content: zipSync(files, { level: 6 }) };
}
