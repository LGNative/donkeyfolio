import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
// @ts-expect-error -- Vite ?raw import has no type declaration
import pdfjsWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?raw";

const MAX_PAGES = 100;
export const LARGE_DOC_THRESHOLD = 50;
const RENDER_SCALE = 2.0;
const JPEG_QUALITY = 0.85;

// Text extraction thresholds
const MIN_TEXT_LENGTH = 50;
const GARBLE_THRESHOLD = 0.3;
const Y_TOLERANCE = 2;
const SPACE_PER_UNIT = 4;

// Blob URL from inlined worker source — must remain alive for the app lifetime
// so pdf.js can spawn workers on demand. Intentionally never revoked.
const workerBlob = new Blob([pdfjsWorkerSrc], { type: "application/javascript" });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

// --- Types ---

type ImageMediaType = "image/jpeg" | "image/png";

export type PageContent =
  | { mode: "text"; text: string; pageNumber: number }
  | { mode: "image"; base64: string; mediaType: ImageMediaType; pageNumber: number };

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

// --- Text extraction ---

function isGarbled(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  const printable = stripped.replace(/[\x20-\x7E\u00A0-\u00FF\u20AC\u00A3\u00A5]/g, "");
  return printable.length / stripped.length > GARBLE_THRESHOLD;
}

function reconstructLayout(items: PositionedTextItem[]): string {
  if (items.length === 0) return "";

  // Sort by Y descending (top of page first in PDF coordinate space)
  const sorted = [...items].sort((a, b) => b.y - a.y);

  // Group into rows: walk sorted list, start new row when Y gap > tolerance
  const rows: PositionedTextItem[][] = [];
  let currentRow: PositionedTextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentY) > Y_TOLERANCE) {
      rows.push(currentRow);
      currentRow = [sorted[i]];
      currentY = sorted[i].y;
    } else {
      currentRow.push(sorted[i]);
    }
  }
  rows.push(currentRow);

  // For each row: sort by X, reconstruct with proportional spacing
  const lines: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let line = "";
    for (let i = 0; i < row.length; i++) {
      if (i > 0) {
        const gap = row[i].x - (row[i - 1].x + row[i - 1].width);
        const spaces = Math.max(1, Math.round(gap / SPACE_PER_UNIT));
        line += " ".repeat(spaces);
      }
      line += row[i].str;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

async function extractPageText(page: pdfjsLib.PDFPageProxy): Promise<string | null> {
  const content = await page.getTextContent();
  const items: PositionedTextItem[] = [];

  for (const item of content.items) {
    const textItem = item as TextItem;
    if (!textItem.str || textItem.str.trim().length === 0) continue;
    items.push({
      str: textItem.str,
      x: textItem.transform[4],
      y: textItem.transform[5],
      width: textItem.width,
    });
  }

  if (items.length === 0) return null;

  // Strip zero-width and control characters that could be used for prompt injection
  const text = reconstructLayout(items).replace(
    /[\u200B-\u200F\u2028-\u202F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    "",
  );
  if (text.length < MIN_TEXT_LENGTH) return null;
  if (isGarbled(text)) return null;

  return text;
}

// --- Page classification ---

async function classifyPage(
  page: pdfjsLib.PDFPageProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): Promise<PageContent> {
  // Try text extraction first
  try {
    const text = await extractPageText(page);
    if (text) {
      page.cleanup();
      return { mode: "text", text, pageNumber };
    }
  } catch {
    // Text extraction failed — fall back to image
  }

  // Fall back to image rendering
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // pdf.js 4.x API: no `canvas` field — it's inferred from canvasContext.
  await page.render({ canvasContext: ctx, viewport }).promise;
  const base64 = canvas.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
  page.cleanup();

  return { mode: "image", base64, mediaType: "image/jpeg", pageNumber };
}

// --- Public API ---

export async function pdfToContent(file: File): Promise<{ pages: PageContent[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageCount = pdf.numPages;

  if (pageCount > MAX_PAGES) {
    pdf.destroy();
    throw new Error(`PDF has ${pageCount} pages. Maximum supported is ${MAX_PAGES}.`);
  }

  const pages: PageContent[] = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create canvas 2D context.");

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    pages.push(await classifyPage(page, i, canvas, ctx));
  }

  // Release canvas pixel buffer
  canvas.width = 0;
  canvas.height = 0;

  pdf.destroy();
  return { pages };
}

export function imageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected reader result type."));
        return;
      }
      resolve(reader.result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export function getMediaType(file: File): ImageMediaType {
  return ALLOWED_IMAGE_TYPES.has(file.type) ? (file.type as ImageMediaType) : "image/jpeg";
}
