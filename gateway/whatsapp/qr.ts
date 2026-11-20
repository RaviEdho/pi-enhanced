import { createRequire } from "node:module";
import { getCapabilities, Image, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface QrMatrix {
  size: number;
  get(row: number, col: number): boolean;
}

const QUIET_ZONE = 4;
// Pi mounts inline dialogs in the editor slot. Leave space for its footer,
// status, and transcript instead of consuming the entire terminal height.
const TERMINAL_MARGIN = 6;
const QR_OPTIONS = { errorCorrectionLevel: "L", margin: QUIET_ZONE } as const;
// Image.render() reserves blank rows and emits a protocol sequence on one row.
// Preserve that sequence verbatim; it has its own cell-size constraints.
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

function qrEncoder() {
  return createRequire(import.meta.url)("qrcode") as {
    create(value: string, options: typeof QR_OPTIONS): { modules: QrMatrix };
    toBuffer(value: string, options: typeof QR_OPTIONS & { scale: number }): Promise<Buffer>;
  };
}

export function renderPairingQr(payload: string): string[] {
  const { modules } = qrEncoder().create(payload, QR_OPTIONS);
  const quiet = QUIET_ZONE;
  const dark = (row: number, col: number) => row >= 0 && row < modules.size && col >= 0 && col < modules.size && modules.get(row, col);
  const lines: string[] = [];
  // Two modules per character cell; leave the standard four-module quiet zone.
  for (let row = -quiet; row < modules.size + quiet; row += 2) {
    let line = "";
    let colors = "";
    for (let col = -quiet; col < modules.size + quiet; col += 1) {
      const next = `${dark(row, col) ? 30 : 97};${dark(row + 1, col) ? 40 : 107}`;
      if (colors !== next) line += `\x1b[${next}m`;
      colors = next;
      line += "▀";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

export class PairingQrView {
  private lines: string[] = [];
  private columns = 0;
  private imageData?: string;
  private image?: Image;
  private imageRows?: number;
  private generation = 0;
  private unavailable = false;
  private preparingImage = false;

  constructor(private readonly refresh: () => void) {}

  setCode(payload?: string) {
    const generation = ++this.generation;
    this.lines = [];
    this.imageData = undefined;
    this.image = undefined;
    this.unavailable = false;
    this.preparingImage = false;
    if (payload !== undefined) {
      try {
        if (typeof payload !== "string" || !payload || payload.length >= 1024) throw new Error("Invalid QR payload");
        this.lines = renderPairingQr(payload);
        this.columns = Math.max(...this.lines.map(visibleWidth));
        // Keep the QR in memory only. Avoid replacing a newly rotated or
        // dismissed code with a late PNG from the previous generation.
        if (getCapabilities().images) {
          const png = qrEncoder().toBuffer(payload, { ...QR_OPTIONS, scale: 6 });
          this.preparingImage = true;
          void png.then((data) => {
            if (generation === this.generation) this.imageData = data.toString("base64");
          }).catch(() => { /* the text QR remains available */ }).finally(() => {
            if (generation !== this.generation) return;
            this.preparingImage = false;
            this.refresh();
          });
        }
      } catch { this.unavailable = true; }
    }
    this.refresh();
  }

  render(width: number, rows: number, heading: string, hint: string, border: () => string): string[] {
    if (width < 1 || rows < 1) return [];
    const height = Math.max(1, rows - TERMINAL_MARGIN);
    const chromeRows = 5; // two borders, title, instructions and key hint
    const available = height - chromeRows;
    const textFits = available >= this.lines.length && this.columns <= width;
    let body: string[] = [];
    if (this.lines.length && textFits) {
      const padding = " ".repeat(Math.floor((width - this.columns) / 2));
      body = this.lines.map((line) => padding + line);
    }
    const imageFits = available >= 10 && width >= 26;
    if (!body.length && this.imageData && imageFits) {
      if (!this.image || this.imageRows !== available) {
        this.image = new Image(this.imageData, "image/png", { fallbackColor: (text) => text }, { maxHeightCells: available });
        this.imageRows = available;
      }
      const imageLines = this.image.render(width);
      if (imageLines.length <= available && imageLines.some(isImageLine)) body = imageLines;
    }
    if (!body.length) {
      body = [this.preparingImage && imageFits ? "Preparing pairing QR…" :
        this.lines.length ? `Enlarge terminal or zoom out for QR (${this.columns} columns × ${this.lines.length + chromeRows + TERMINAL_MARGIN} rows).` :
          this.unavailable ? "Could not render the pairing QR. Press Esc and try setup again." : "Waiting for WhatsApp…"];
    }
    // On very short terminals prioritize the status and always keep Esc in
    // reach. Never truncate or partially display a QR matrix.
    const lines = available > 0
      ? [border(), heading, "WhatsApp → Linked Devices → Link a device", ...body, hint, border()]
      : [...body, ...(height > 1 ? [hint] : [])];
    return lines.map((line) => isImageLine(line) ? line : truncateToWidth(line, width));
  }

  invalidate() {
    this.image?.invalidate();
  }

  clear() {
    ++this.generation;
    this.lines = [];
    this.imageData = undefined;
    this.image = undefined;
  }
}
