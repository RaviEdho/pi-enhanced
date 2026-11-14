import MarkdownIt from "markdown-it";

// No HTML renderer, browser, remote fonts, images or URLs are ever evaluated.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const MAX_REPLY_CHARS = 200_000;
const MAX_TABLE_BYTES = 64 * 1024;
const MAX_ROWS = 200;
const MAX_COLUMNS = 20;
const FONT_SIZE = 20;
const CHARACTER_WIDTH = 12.4;
const LINE_HEIGHT = 28;
const PADDING = 14;
const MARGIN = 18;
const TITLE_HEIGHT = 42;
const FOOTER_HEIGHT = 38;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1400;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function inlineText(tokens = []) {
  return tokens.map((token) => {
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    if (token.type === "image") return inlineText(token.children) || token.content;
    if (["text", "code_inline"].includes(token.type)) return token.content;
    return token.children ? inlineText(token.children) : "";
  }).join("");
}

/** Exact source slices; nested tables stay text rather than breaking list/quote syntax. */
export function partitionMarkdownTables(source) {
  if (source.length > MAX_REPLY_CHARS || !source.includes("|")) return [{ type: "text", raw: source }];
  const offsets = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index + match[0].length);
  const tokens = markdown.parse(source, {});
  const parts = [];
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "table_open" || token.level !== 0 || !token.map) continue;
    const start = offsets[token.map[0]];
    const end = offsets[token.map[1]] ?? source.length;
    if (start > cursor) parts.push({ type: "text", raw: source.slice(cursor, start) });
    const rows = [];
    const align = [];
    let row;
    for (index += 1; index < tokens.length && tokens[index].type !== "table_close"; index += 1) {
      const child = tokens[index];
      if (child.type === "tr_open") { row = []; rows.push(row); }
      if (child.type === "th_open") align.push(child.attrGet("style")?.replace("text-align:", "") || "left");
      if (child.type === "inline" && row) row.push(inlineText(child.children));
    }
    parts.push({ type: "table", raw: source.slice(start, end), rows, align });
    cursor = end;
  }
  if (cursor < source.length || parts.length === 0) parts.push({ type: "text", raw: source.slice(cursor) });
  return parts;
}

function cleanText(value) {
  return value.replace(/<br\s*\/?>/gi, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").toWellFormed();
}

function cellWidth(character) {
  if (/^\p{Mark}+$/u.test(character)) return 0;
  return /[\p{Extended_Pictographic}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1;
}

function textWidth(text) {
  let size = 0;
  for (const { segment } of graphemes.segment(text)) size += cellWidth(segment);
  return size;
}

function wrapText(text, capacity) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let width = 0;
    for (const word of paragraph.match(/\S+/gu) || []) {
      const size = textWidth(word);
      if (line && width + 1 + size > capacity) { lines.push(line); line = ""; width = 0; }
      if (line) { line += " "; width += 1; }
      for (const { segment } of graphemes.segment(word)) {
        const next = cellWidth(segment);
        if (line && width + next > capacity) { lines.push(line); line = ""; width = 0; }
        line += segment;
        width += next;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Split wide tables into panels, repeating the first (usually identifying) column.
function columnPanels(widths) {
  const panels = [];
  let columns = [0];
  let width = widths[0];
  for (let column = 1; column < widths.length; column += 1) {
    if (width + widths[column] > MAX_WIDTH - MARGIN * 2) {
      panels.push(columns);
      columns = [0];
      width = widths[0];
    }
    columns.push(column);
    width += widths[column];
  }
  panels.push(columns);
  return panels;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function pageSvg(page, widths, align, number, pageNumber, pageCount, showTitleFooter) {
  const width = Math.max(showTitleFooter ? 360 : 0, page.columns.reduce((sum, column) => sum + widths[column], MARGIN * 2));
  const height = MARGIN * 2 + (showTitleFooter ? TITLE_HEIGHT + FOOTER_HEIGHT : 0) + page.rows.reduce((sum, row) => sum + row.height, 0);
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#1e1f22"/>`,
    `<g font-family="DejaVu Sans Mono,monospace" font-size="${FONT_SIZE}" fill="#f2f3f5">`,
  ];
  if (showTitleFooter) elements.push(`<text x="${MARGIN}" y="${MARGIN + FONT_SIZE}" font-weight="bold">Table ${number}${pageCount > 1 ? ` · ${pageNumber}/${pageCount}` : ""}</text>`);
  let y = MARGIN + (showTitleFooter ? TITLE_HEIGHT : 0);
  for (const [rowIndex, row] of page.rows.entries()) {
    let x = MARGIN;
    for (const [index, column] of page.columns.entries()) {
      const columnWidth = widths[column];
      elements.push(`<rect x="${x}" y="${y}" width="${columnWidth}" height="${row.height}" fill="${rowIndex === 0 ? "#353d59" : row.sourceIndex % 2 ? "#292b30" : "#232428"}" stroke="#555963"/>`);
      const alignment = align[column];
      const anchor = alignment === "right" ? "end" : alignment === "center" ? "middle" : "start";
      const textX = alignment === "right" ? x + columnWidth - PADDING : alignment === "center" ? x + columnWidth / 2 : x + PADDING;
      for (const [lineIndex, line] of row.cells[index].entries()) {
        elements.push(`<text x="${textX}" y="${y + PADDING + FONT_SIZE + lineIndex * LINE_HEIGHT}" text-anchor="${anchor}"${rowIndex === 0 ? ' font-weight="bold"' : ""}>${escapeXml(line)}</text>`);
      }
      x += columnWidth;
    }
    y += row.height;
  }
  const bodyRows = page.rows.slice(1);
  const range = bodyRows.length ? `Rows ${bodyRows[0].sourceIndex}–${bodyRows.at(-1).sourceIndex}` : "Header only";
  const columns = `Columns ${page.columns.map((column) => column + 1).join(", ")}`;
  if (showTitleFooter) elements.push(`<text x="${MARGIN}" y="${y + 26}" font-size="15" fill="#c5c8d0">${range} · ${columns}</text>`);
  elements.push("</g></svg>");
  // Alt text retains page/range context even when visible decorations are off.
  return { svg: elements.join(""), description: `Table ${number}, page ${pageNumber} of ${pageCount}. ${range}; ${columns.toLowerCase()}.` };
}

/** Fully plan and render a bounded table before the caller uploads anything. */
export async function renderTable(table, { number = 1, showTitleFooter = false, maxImages = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
  const columns = table.rows[0]?.length || 0;
  if (maxImages < 1 || maxBytes < 1 || Buffer.byteLength(table.raw) > MAX_TABLE_BYTES || columns < 1 || columns > MAX_COLUMNS ||
      table.rows.length > MAX_ROWS + 1 || table.rows.some((row) => row.length !== columns || row.some((cell) => cell.length > 4000))) {
    throw new RangeError("Table exceeds image layout bounds");
  }
  const rows = table.rows.map((row) => row.map(cleanText));
  const widths = rows[0].map((_, column) => Math.min(340, Math.max(150,
    Math.max(...rows.map((row) => Math.max(...row[column].split("\n").map(textWidth)))) * CHARACTER_WIDTH + PADDING * 2)));
  const pages = [];
  for (const panel of columnPanels(widths)) {
    const wrapped = rows.map((row, sourceIndex) => {
      const cells = panel.map((column) => wrapText(row[column], Math.floor((widths[column] - PADDING * 2) / CHARACTER_WIDTH)));
      return { cells, sourceIndex, height: Math.max(...cells.map((cell) => cell.length)) * LINE_HEIGHT + PADDING * 2 };
    });
    const header = wrapped[0];
    const capacity = MAX_HEIGHT - MARGIN * 2 - (showTitleFooter ? TITLE_HEIGHT + FOOTER_HEIGHT : 0);
    if (header.height > capacity / 2) throw new RangeError("Table header is too tall");
    let page = { columns: panel, rows: [header] };
    let height = header.height;
    for (const row of wrapped.slice(1)) {
      if (header.height + row.height > capacity) throw new RangeError("Table row is too tall");
      if (height + row.height > capacity) { pages.push(page); page = { columns: panel, rows: [header] }; height = header.height; }
      page.rows.push(row);
      height += row.height;
    }
    pages.push(page);
    if (pages.length > maxImages) throw new RangeError("Table needs too many images");
  }
  // Lazy loading lets parsing and the gateway keep working if native sharp is unavailable.
  const { default: sharp } = await import("sharp");
  const images = [];
  let bytes = 0;
  for (const [index, page] of pages.entries()) {
    const { svg, description } = pageSvg(page, widths, table.align, number, index + 1, pages.length, showTitleFooter);
    const data = await sharp(Buffer.from(svg), { density: 144, limitInputPixels: 7_000_000 })
      .png().timeout({ seconds: 5 }).toBuffer();
    bytes += data.length;
    if (data.length > MAX_IMAGE_BYTES || bytes > maxBytes) throw new RangeError("Table images exceed upload limits");
    images.push({ attachment: data, name: `table-${number}-${index + 1}.png`, description });
  }
  return images;
}
