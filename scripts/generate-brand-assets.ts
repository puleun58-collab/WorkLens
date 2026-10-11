import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkLensMark } from "../src/app/worklens-logo";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDirectory = path.join(root, "public", "brand");
const appDirectory = path.join(root, "src", "app");
const fontDirectory = path.join(root, "public", "fonts", "pretendard", "woff2-dynamic-subset");
const navy = "#172033";
const blue = "#2563eb";

// The JSX component remains the sole source of truth for the full-size symbol.
function fullMark(tone: "default" | "light" = "default") {
  const rendered = renderToStaticMarkup(createElement(WorkLensMark, { size: 64, tone }));
  const match = rendered.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);
  if (!match) throw new Error("WorkLensMark did not render an SVG");
  return match[1];
}

function symbolSvg(paths: string, size: number, label = "WorkLens") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label}">${paths}</svg>\n`;
}

// The compact variant preserves the lens, both text strokes, and the lower-right handle.
// Its two page layers and slightly heavier text strokes survive 16px rasterization.
const smallMark = [
  '<path fill="#1d4ed8" d="M4 36 23 26 44 37 25 48a5 5 0 0 1-4 0L4 40a2 2 0 0 1 0-4Z"/>',
  '<path fill="#93c5fd" d="M4 20 23 10 44 21 25 32a5 5 0 0 1-4 0L4 24a2 2 0 0 1 0-4Z"/>',
  `<path fill="${navy}" d="m48 39 12 12a4.2 4.2 0 0 1-6 6L42 45Z"/>`,
  `<circle cx="36" cy="27" r="19" fill="${blue}"/>`,
  '<circle cx="36" cy="27" r="14.5" fill="#eff6ff"/>',
  '<path d="m27 25 16-8m-14 17 16-8" stroke="#3b82f6" stroke-width="5" stroke-linecap="round"/>',
].join("");

// Derive the OG raster's subset choices from the app's own font-face ranges;
// no host font or remotely served asset is needed for the browser capture.
const fontCss = await readFile(path.join(appDirectory, "globals.css"), "utf8");
const fontFaces = [...fontCss.matchAll(/@font-face\s*\{[^}]*?PretendardVariable\.subset\.(\d+)\.woff2[^}]*?unicode-range:\s*([^;]+);[^}]*\}/g)].map((match) => ({
  index: Number(match[1]),
  ranges: match[2].split(",").map((part) => {
    const endpoints = part.trim().replace(/^U\+/i, "").split("-").map((value) => parseInt(value, 16));
    return [endpoints[0], endpoints[1] ?? endpoints[0]] as const;
  }),
}));
if (fontFaces.length === 0) throw new Error("Pretendard dynamic subset definitions were not found");

function fontSubsets(text: string) {
  const characters = [...new Set([...text].map((character) => character.codePointAt(0)!))];
  const selected = fontFaces.filter(({ ranges }) => characters.some((code) => ranges.some(([start, end]) => start <= code && code <= end)));
  if (characters.some((code) => !selected.some(({ ranges }) => ranges.some(([start, end]) => start <= code && code <= end)))) {
    throw new Error("The bundled Pretendard font does not cover all brand text");
  }
  return selected;
}

async function embeddedFontFaces(text: string) {
  return (await Promise.all(fontSubsets(text).map(async ({ index, ranges }) => {
    const font = await readFile(path.join(fontDirectory, `PretendardVariable.subset.${index}.woff2`));
    return `@font-face{font-family:"Pretendard Brand";font-style:normal;font-weight:45 920;src:url("data:font/woff2;base64,${font.toString("base64")}") format("woff2");unicode-range:${ranges.map(([start, end]) => `U+${start.toString(16)}${end === start ? "" : `-${end.toString(16)}`}`).join(",")};}`;
  }))).join("");
}

// Pretendard Variable subset 91, weight 700 at 37px with -0.015em tracking.
// Outlined once from the already bundled font so standalone SVG needs no font loads.
const wordmarkPaths = ["M76.599 18.84H82.505L86.897 37.13H87.13L91.922 18.84H97.044L101.851 37.171H102.068L106.461 18.84H112.367L104.906 45.0H99.582L94.589 27.732H94.392L89.383 45.0H84.08ZM113.697 35.26Q113.697 32.225 114.868 29.94Q116.039 27.656 118.224 26.392Q120.409 25.127 123.333 25.127Q126.257 25.127 128.444 26.392Q130.631 27.656 131.794 29.94Q132.958 32.225 132.958 35.26Q132.958 38.259 131.794 40.553Q130.631 42.848 128.444 44.112Q126.257 45.377 123.333 45.377Q120.409 45.377 118.224 44.112Q116.039 42.848 114.868 40.553Q113.697 38.259 113.697 35.26ZM127.519 35.219Q127.519 33.482 127.05 32.119Q126.581 30.755 125.648 29.979Q124.716 29.202 123.373 29.202Q122.011 29.202 121.05 29.979Q120.089 30.755 119.602 32.108Q119.115 33.461 119.115 35.219Q119.115 36.976 119.602 38.332Q120.089 39.687 121.05 40.464Q122.011 41.24 123.373 41.24Q124.716 41.24 125.648 40.464Q126.581 39.687 127.05 38.322Q127.519 36.956 127.519 35.219ZM135.783 25.38H140.95V28.788H141.166Q141.688 26.984 142.946 26.04Q144.204 25.096 145.877 25.096Q146.74 25.096 147.585 25.27V30.05Q147.241 29.916 146.56 29.834Q145.88 29.751 145.297 29.751Q144.108 29.751 143.162 30.266Q142.216 30.78 141.668 31.715Q141.119 32.651 141.119 33.849V45.0H135.783ZM154.501 32.866H155.299L161.664 25.38H167.825L159.338 35.218H158.088L154.496 39.273ZM149.663 18.84H154.999V45.0H149.663ZM156.075 36.416 159.633 32.632 168.194 45.0H161.924Z","M169.869 18.84H175.289V40.514H186.55V45.0H169.869ZM188.584 35.291Q188.584 32.272 189.766 29.962Q190.947 27.651 193.096 26.389Q195.244 25.127 198.086 25.127Q200.736 25.127 202.814 26.235Q204.893 27.344 206.085 29.589Q207.278 31.834 207.278 35.062V36.567H190.773V33.214H202.232Q202.232 32.022 201.715 31.097Q201.197 30.173 200.273 29.647Q199.349 29.121 198.168 29.121Q196.925 29.121 195.951 29.694Q194.978 30.267 194.429 31.254Q193.88 32.242 193.86 33.418V36.559Q193.86 38.031 194.414 39.127Q194.968 40.223 195.993 40.803Q197.019 41.383 198.375 41.383Q199.271 41.383 200.01 41.127Q200.75 40.871 201.27 40.445Q201.79 40.018 202.049 39.429H207.152Q206.764 41.218 205.588 42.563Q204.412 43.908 202.541 44.642Q200.67 45.377 198.294 45.377Q195.327 45.377 193.137 44.151Q190.947 42.925 189.766 40.648Q188.584 38.372 188.584 35.291ZM215.429 45.0H210.092V25.38H215.177V28.819H215.389Q216.087 27.086 217.608 26.107Q219.13 25.127 221.298 25.127Q223.342 25.127 224.864 26.012Q226.386 26.896 227.22 28.558Q228.053 30.22 228.053 32.493V45.0H222.717V33.426Q222.717 32.215 222.305 31.356Q221.894 30.497 221.105 30.031Q220.315 29.566 219.193 29.566Q218.075 29.566 217.22 30.047Q216.366 30.528 215.897 31.442Q215.429 32.356 215.429 33.63ZM239.631 28.93Q238.766 28.93 238.072 29.177Q237.378 29.423 236.979 29.885Q236.58 30.346 236.58 30.932Q236.56 31.621 237.166 32.124Q237.772 32.626 239.102 32.901L242.642 33.624Q245.505 34.197 246.898 35.506Q248.29 36.814 248.29 38.935Q248.29 40.838 247.203 42.298Q246.116 43.757 244.156 44.567Q242.197 45.377 239.592 45.377Q236.979 45.377 235.072 44.632Q233.165 43.887 232.064 42.498Q230.964 41.108 230.731 39.194H236.11Q236.338 40.317 237.232 40.909Q238.127 41.501 239.601 41.501Q240.565 41.501 241.299 41.263Q242.032 41.024 242.439 40.562Q242.845 40.101 242.845 39.484Q242.845 38.702 242.201 38.212Q241.557 37.722 240.182 37.443L236.932 36.797Q234.122 36.244 232.682 34.828Q231.243 33.412 231.264 31.256Q231.264 29.369 232.277 27.989Q233.291 26.608 235.16 25.868Q237.029 25.127 239.549 25.127Q242.007 25.127 243.831 25.867Q245.655 26.607 246.692 27.981Q247.728 29.355 247.847 31.211H242.849Q242.667 30.135 241.816 29.533Q240.966 28.93 239.631 28.93Z"] as const;
function logoSvg(light = false) {
  const paths = fullMark(light ? "light" : "default");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="264" height="64" viewBox="0 0 264 64" role="img" aria-label="WorkLens"><g>${paths}</g><path fill="${light ? "#ffffff" : navy}" d="${wordmarkPaths[0]}"/><path fill="${blue}" d="${wordmarkPaths[1]}"/></svg>\n`;
}

function icoFromPngs(images: { size: number; png: Buffer }[]) {
  const table = Buffer.alloc(6 + images.length * 16);
  table.writeUInt16LE(1, 2); // icon (rather than cursor)
  table.writeUInt16LE(images.length, 4);
  let offset = table.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    table[entry] = size === 256 ? 0 : size;
    table[entry + 1] = size === 256 ? 0 : size;
    table[entry + 2] = 0; // no palette
    table[entry + 3] = 0;
    table.writeUInt16LE(1, entry + 4); // one color plane
    table.writeUInt16LE(32, entry + 6); // RGBA
    table.writeUInt32LE(png.length, entry + 8);
    table.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([table, ...images.map(({ png }) => png)]);
}

await mkdir(brandDirectory, { recursive: true });
const full = fullMark();
await Promise.all([
  Bun.write(path.join(brandDirectory, "worklens-mark.svg"), symbolSvg(full, 64)),
  Bun.write(path.join(brandDirectory, "worklens-mark-dark.svg"), symbolSvg(full, 64)),
  Bun.write(path.join(brandDirectory, "worklens-mark-light.svg"), symbolSvg(fullMark("light"), 64)),
  Bun.write(path.join(brandDirectory, "worklens-mark-small.svg"), symbolSvg(smallMark, 64)),
  Bun.write(path.join(appDirectory, "icon.svg"), symbolSvg(smallMark, 64)),
  Bun.write(path.join(brandDirectory, "worklens-logo.svg"), logoSvg()),
  Bun.write(path.join(brandDirectory, "worklens-logo-light.svg"), logoSvg(true)),
]);

// A browser capture provides consistent glyph shaping for the Korean copy.
// Assets are embedded in the page, so generating them never needs a server.
const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
try {
  const iconPngs: { size: number; png: Buffer }[] = [];
  for (const size of [16, 32, 64, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const icon = symbolSvg(size < 64 ? smallMark : full, size);
    await page.setContent(`<html><style>html,body{margin:0;background:transparent}</style><body>${icon}</body></html>`);
    const png = await page.screenshot({ type: "png", omitBackground: true });
    iconPngs.push({ size, png });
    await Bun.write(path.join(brandDirectory, `worklens-icon-${size}.png`), png);
    await page.close();
  }
  await Bun.write(path.join(appDirectory, "favicon.ico"), icoFromPngs(iconPngs));

  const ogFonts = await embeddedFontFaces("WorkLens업무 문서 작업 공간");
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><style>
    ${ogFonts}
    *{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;background:#f6f7fb;color:${navy}}
    body{font-family:"Pretendard Brand",sans-serif;-webkit-font-smoothing:antialiased}
    .sheet{position:relative;width:1200px;height:630px}
    .brand{position:absolute;left:88px;top:190px;display:flex;align-items:center;gap:24px;height:104px;transform:scale(1.15);transform-origin:top left}
    .brand svg{width:104px;height:104px;flex:none}
    .brand-name{font-size:70px;font-weight:700;letter-spacing:-1.05px;line-height:1}
    .brand-name span{color:${blue}}
    h1{position:absolute;left:88px;top:364px;margin:0;font-size:61px;letter-spacing:-1.6px;line-height:1.25;font-weight:700}
  </style></head><body><main class="sheet"><div class="brand">${symbolSvg(full, 64)}<div class="brand-name">Work<span>Lens</span></div></div><h1>업무 문서 작업 공간</h1></main></body></html>`;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await Bun.write(path.join(brandDirectory, "worklens-og-document-lens.png"), await page.screenshot({ type: "png" }));
  await page.close();
} finally {
  await browser.close();
}
