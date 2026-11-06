/**
 * The print preview's choices (src/main/print-preview.ts), checked, and what they become
 * for Electron: options for webContents.printToPDF (the preview and Save as PDF) and for
 * webContents.print (a printer). No Electron here, so plain tests read it.
 *
 * A choice comes from the preview's page, which only the shell draws; it is still checked,
 * since it ends up in a print job: a printer must be one the OS listed, numbers stay in range.
 */

export const PAPER_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
/** `printer`: what the printer itself uses (Electron's usePrinterDefaultPageSize). Printers only. */
export type PaperChoice = PaperSize | 'printer';
export type MarginChoice = 'default' | 'none' | 'minimum';

export type Destination = { kind: 'pdf' } | { kind: 'printer'; name: string };

export interface PrintChoices {
  destination: Destination;
  /** As typed: '' for all pages, else "1-3, 5". */
  pages: string;
  copies: number;
  landscape: boolean;
  color: boolean;
  paper: PaperChoice;
  margins: MarginChoice;
  /** Percent. */
  scale: number;
  headerFooter: boolean;
  background: boolean;
}

/** What is kept per destination between prints. Not the pages or the copies: those are this print's. */
export type RememberedChoices = Pick<PrintChoices, 'landscape' | 'color' | 'paper' | 'margins' | 'scale' | 'headerFooter' | 'background'>;

export interface PrintMemory {
  /** The destination used last: 'pdf', or `printer:<name>`. */
  last?: string;
  byDestination: Record<string, RememberedChoices>;
}

export const LIMITS = { copies: 99, scaleMin: 10, scaleMax: 200, pagesText: 200, remembered: 20, printerName: 260 };

export interface PrinterEntry {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export function destinationKey(destination: Destination): string {
  return destination.kind === 'pdf' ? 'pdf' : `printer:${destination.name}`;
}

/** Countries where Letter is the paper in the drawer. Everywhere else A4. */
const LETTER_COUNTRIES = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI']);

export function localPaper(country: string | undefined): PaperSize {
  return country && LETTER_COUNTRIES.has(country.toUpperCase()) ? 'Letter' : 'A4';
}

/**
 * The paper a printer says it uses, where the OS tells (CUPS gives `media`, e.g.
 * `iso_a4_210x297mm` or `na_letter_8.5x11in`). Windows doesn't through Electron.
 */
export function printerPaper(options: Record<string, string> | undefined): PaperSize | null {
  const media = (options?.media ?? options?.['media-default'] ?? options?.PageSize ?? '').toLowerCase();
  if (!media) return null;
  if (/(^|_)a4(_|$)/.test(media)) return 'A4';
  if (/(^|_)a3(_|$)/.test(media)) return 'A3';
  if (/(^|_)a5(_|$)/.test(media)) return 'A5';
  if (/letter/.test(media)) return 'Letter';
  if (/legal/.test(media)) return 'Legal';
  if (/tabloid|ledger|11x17/.test(media)) return 'Tabloid';
  return null;
}

/** CUPS marks the default printer in `printer-type` (CUPS_PRINTER_DEFAULT). */
const CUPS_PRINTER_DEFAULT = 0x20000;

/**
 * The OS's printers, the default first and the rest by name. `defaultName`: what the OS
 * says is the default (Windows, from the registry); CUPS says it in the printer's options.
 */
export function sortPrinters(list: { name: string; displayName?: string; options?: Record<string, string> }[], defaultName: string | null): PrinterEntry[] {
  const seen = new Set<string>();
  const entries: PrinterEntry[] = [];
  for (const printer of list) {
    if (typeof printer.name !== 'string' || !printer.name || printer.name.length > LIMITS.printerName || seen.has(printer.name)) continue;
    seen.add(printer.name);
    const cupsType = Number(printer.options?.['printer-type']);
    const isDefault = defaultName ? printer.name === defaultName : Number.isFinite(cupsType) && (cupsType & CUPS_PRINTER_DEFAULT) !== 0;
    entries.push({ name: printer.name, displayName: oneLine(printer.displayName || printer.name), isDefault });
  }
  return entries.sort((a, b) => (a.isDefault === b.isDefault ? a.displayName.localeCompare(b.displayName) : a.isDefault ? -1 : 1));
}

/** Windows keeps the default printer as `name,winspool,port` under HKCU\…\Windows, value Device. */
export function windowsDefaultPrinter(device: string | null | undefined): string | null {
  if (!device) return null;
  const name = device.split(',')[0]?.trim();
  return name || null;
}

function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.printerName);
}

/** Where a new preview starts: the last one used if it is still there, else the default printer, else the first, else a PDF. */
export function initialDestination(printers: PrinterEntry[], memory: PrintMemory | undefined, allowed: { print: boolean; pdf: boolean }): Destination | null {
  const last = memory?.last;
  if (last === 'pdf' && allowed.pdf) return { kind: 'pdf' };
  if (allowed.print) {
    const lastPrinter = last?.startsWith('printer:') ? last.slice('printer:'.length) : null;
    const found = printers.find((printer) => printer.name === lastPrinter) ?? printers[0];
    if (found) return { kind: 'printer', name: found.name };
  }
  return allowed.pdf ? { kind: 'pdf' } : null;
}

export function defaultChoices(destination: Destination, remembered: RememberedChoices | undefined, paper: PaperSize): PrintChoices {
  const base: PrintChoices = {
    destination,
    pages: '',
    copies: 1,
    landscape: false,
    color: true,
    paper: destination.kind === 'printer' ? 'printer' : paper,
    margins: 'default',
    scale: 100,
    headerFooter: false,
    background: true,
  };
  if (!remembered) return base;
  const checked = readRemembered(remembered, destination);
  return checked ? { ...base, ...checked } : base;
}

/**
 * Another destination picked in an open preview: what was used there last, if anything,
 * else what is chosen now. The pages stay, they are this print's; a PDF is one copy in colour.
 */
export function switchDestination(current: PrintChoices, destination: Destination, remembered: RememberedChoices | undefined, paper: PaperSize): PrintChoices {
  const pdf = destination.kind === 'pdf';
  if (remembered) {
    return { ...defaultChoices(destination, remembered, paper), pages: current.pages, copies: pdf ? 1 : current.copies };
  }
  return {
    ...current,
    destination,
    // "The printer's own" means nothing for a PDF.
    paper: pdf && current.paper === 'printer' ? paper : current.paper,
    copies: pdf ? 1 : current.copies,
    color: pdf ? true : current.color,
  };
}

function readPaper(value: unknown, destination: Destination): PaperChoice | undefined {
  if (value === 'printer') return destination.kind === 'printer' ? 'printer' : undefined;
  return typeof value === 'string' && (PAPER_SIZES as readonly string[]).includes(value) ? (value as PaperSize) : undefined;
}

function readScale(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(LIMITS.scaleMax, Math.max(LIMITS.scaleMin, value))) : undefined;
}

function readRemembered(value: unknown, destination: Destination): RememberedChoices | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const paper = readPaper(raw.paper, destination);
  const scale = readScale(raw.scale);
  const margins = raw.margins === 'none' || raw.margins === 'minimum' || raw.margins === 'default' ? raw.margins : undefined;
  if (paper === undefined || scale === undefined || margins === undefined) return null;
  return {
    landscape: raw.landscape === true,
    color: raw.color !== false,
    paper,
    margins,
    scale,
    headerFooter: raw.headerFooter === true,
    background: raw.background !== false,
  };
}

/**
 * The choices the preview's page sent, checked. Null when the destination isn't one there is
 * (a printer the OS didn't list, a PDF when Save as PDF is off).
 */
export function readPrintChoices(value: unknown, context: { printers: PrinterEntry[]; allowed: { print: boolean; pdf: boolean } }): PrintChoices | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const rawDestination = (raw.destination && typeof raw.destination === 'object' ? raw.destination : {}) as Record<string, unknown>;
  let destination: Destination;
  if (rawDestination.kind === 'pdf') {
    if (!context.allowed.pdf) return null;
    destination = { kind: 'pdf' };
  } else if (rawDestination.kind === 'printer' && typeof rawDestination.name === 'string') {
    if (!context.allowed.print || !context.printers.some((printer) => printer.name === rawDestination.name)) return null;
    destination = { kind: 'printer', name: rawDestination.name };
  } else {
    return null;
  }
  const copies = typeof raw.copies === 'number' && Number.isInteger(raw.copies) ? Math.min(LIMITS.copies, Math.max(1, raw.copies)) : 1;
  const remembered = readRemembered(raw, destination);
  if (!remembered) return null;
  return {
    destination,
    pages: typeof raw.pages === 'string' ? raw.pages.slice(0, LIMITS.pagesText) : '',
    // A PDF is one copy.
    copies: destination.kind === 'pdf' ? 1 : copies,
    ...remembered,
    // Save as PDF keeps the colours; black and white is the printer's.
    color: destination.kind === 'pdf' ? true : remembered.color,
  };
}

export function rememberedOf(choices: PrintChoices): RememberedChoices {
  const { landscape, color, paper, margins, scale, headerFooter, background } = choices;
  return { landscape, color, paper, margins, scale, headerFooter, background };
}

/** The memory with these choices in it, the oldest destinations dropped past the limit. */
export function remember(memory: PrintMemory | undefined, choices: PrintChoices): PrintMemory {
  const key = destinationKey(choices.destination);
  const byDestination = { ...(memory?.byDestination ?? {}) };
  delete byDestination[key];
  byDestination[key] = rememberedOf(choices);
  const keys = Object.keys(byDestination);
  for (const old of keys.slice(0, Math.max(0, keys.length - LIMITS.remembered))) delete byDestination[old];
  return { last: key, byDestination };
}

export function rememberedFor(memory: PrintMemory | undefined, destination: Destination): RememberedChoices | undefined {
  const value = memory?.byDestination?.[destinationKey(destination)];
  return value ? readRemembered(value, destination) ?? undefined : undefined;
}

/** Pages to print, 1-based and inclusive, sorted and merged. */
export type PageRange = [from: number, to: number];

/**
 * "1-3, 5, 8-" as Chrome reads it: pages and ranges split by commas, `8-` up to the last
 * page, `-3` from the first. '' is every page. Null when it names a page that isn't there.
 */
export function parsePageRanges(text: string, total: number): PageRange[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [[1, total]];
  if (total < 1) return null;
  const ranges: PageRange[] = [];
  for (const part of trimmed.split(/[,;]/)) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^(\d{1,6})?\s*(-)?\s*(\d{1,6})?$/.exec(piece);
    if (!match || (!match[1] && !match[3])) return null;
    const dash = match[2] === '-';
    if (!dash && match[1] && match[3]) return null;
    const from = match[1] ? Number(match[1]) : 1;
    const to = dash ? (match[3] ? Number(match[3]) : total) : from;
    if (from < 1 || to < from || to > total) return null;
    ranges.push([from, to]);
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: PageRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export function isEveryPage(ranges: PageRange[], total: number): boolean {
  return ranges.length === 1 && ranges[0][0] === 1 && ranges[0][1] === total;
}

export function pageCount(ranges: PageRange[]): number {
  return ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0);
}

/** printToPDF's form: "1-3,5". */
export function pdfPageRanges(ranges: PageRange[]): string {
  return ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(',');
}

/** webContents.print's form: 0-based. */
export function printPageRanges(ranges: PageRange[]): { from: number; to: number }[] {
  return ranges.map(([from, to]) => ({ from: from - 1, to: to - 1 }));
}

/** Margins in inches for the preview. Chromium's default is 1 cm; a printer's minimum is its own, about 5 mm. */
const MARGIN_INCHES: Record<MarginChoice, number> = { default: 0.4, none: 0, minimum: 0.2 };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Chrome's header and footer: the date and the title on top, the page number at the bottom. */
function headerTemplate(title: string, date: string): string {
  return `<div style="width:100%;font-size:8px;padding:0 0.4in;display:flex;justify-content:space-between;font-family:system-ui,sans-serif;"><span>${escapeHtml(date)}</span><span>${escapeHtml(title)}</span><span></span></div>`;
}

const FOOTER_TEMPLATE = '<div style="width:100%;font-size:8px;padding:0 0.4in;text-align:right;font-family:system-ui,sans-serif;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>';

export interface PdfOptions {
  landscape: boolean;
  printBackground: boolean;
  scale: number;
  pageSize: PaperSize;
  margins: { top: number; bottom: number; left: number; right: number };
  displayHeaderFooter: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  pageRanges?: string;
}

/**
 * printToPDF's options for these choices, without page ranges. `paper` is what stands
 * in for "the printer's own" in the preview. A PDF source keeps its own margins.
 */
export function pdfOptions(choices: PrintChoices, context: { paper: PaperSize; title: string; date: string; source: 'html' | 'pdf' }): PdfOptions {
  const inches = context.source === 'pdf' ? 0 : MARGIN_INCHES[choices.margins];
  // Room for the header and footer lines, as Chrome makes when its margins are smaller.
  const edge = choices.headerFooter && context.source === 'html' ? Math.max(inches, 0.4) : inches;
  return {
    landscape: choices.landscape,
    printBackground: choices.background,
    scale: choices.scale / 100,
    pageSize: choices.paper === 'printer' ? context.paper : choices.paper,
    margins: { top: edge, bottom: edge, left: inches, right: inches },
    displayHeaderFooter: choices.headerFooter && context.source === 'html',
    ...(choices.headerFooter && context.source === 'html' ? { headerTemplate: headerTemplate(context.title, context.date), footerTemplate: FOOTER_TEMPLATE } : {}),
  };
}

export interface DevicePrintOptions {
  silent: true;
  deviceName: string;
  copies: number;
  collate: boolean;
  landscape: boolean;
  color: boolean;
  printBackground: boolean;
  scaleFactor: number;
  margins: { marginType: 'default' | 'none' | 'printableArea' };
  pageSize?: PaperSize;
  usePrinterDefaultPageSize?: boolean;
  pageRanges?: { from: number; to: number }[];
  header?: string;
  footer?: string;
}

/** webContents.print's options for a printer. Null for Save as PDF, which isn't printed. */
export function devicePrintOptions(choices: PrintChoices, ranges: PageRange[], total: number, title: string): DevicePrintOptions | null {
  if (choices.destination.kind !== 'printer') return null;
  const marginType = choices.margins === 'minimum' ? 'printableArea' : choices.margins;
  return {
    silent: true,
    deviceName: choices.destination.name,
    copies: choices.copies,
    collate: true,
    landscape: choices.landscape,
    color: choices.color,
    printBackground: choices.background,
    // Electron passes it on as Chromium's percentage.
    scaleFactor: choices.scale,
    margins: { marginType },
    ...(choices.paper === 'printer' ? { usePrinterDefaultPageSize: true } : { pageSize: choices.paper }),
    ...(isEveryPage(ranges, total) ? {} : { pageRanges: printPageRanges(ranges) }),
    // Chromium draws the date and the page numbers with them. No footer: it would be the app's address.
    ...(choices.headerFooter ? { header: title || 'Bulwark', footer: '' } : {}),
  };
}

/**
 * Pages in a PDF: each page object, as Skia and most writers leave them readable. Falls back
 * to the page tree's /Count for one that hides its objects in streams.
 */
export function countPdfPages(data: Uint8Array): number {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages > 0) return pages;
  let most = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) most = Math.max(most, Number(match[1]));
  return most;
}

/** The preview window around its card: as large as fits, centred on the window it prints from. */
export const PREVIEW_CARD = { width: 1040, height: 760, minWidth: 720, minHeight: 520, margin: 32 };

export function previewBounds(
  parent: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(PREVIEW_CARD.width + 2 * PREVIEW_CARD.margin, workArea.width);
  const height = Math.min(PREVIEW_CARD.height + 2 * PREVIEW_CARD.margin, workArea.height);
  const x = Math.round(parent.x + (parent.width - width) / 2);
  const y = Math.round(parent.y + (parent.height - height) / 2);
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

export type ReadPreviewRequest =
  | { source: 'page'; title: string; theme?: unknown }
  | { source: 'window'; name: string; title: string; theme?: unknown }
  | { source: 'pdf'; data: Uint8Array; title: string; theme?: unknown };

/** A page's print.preview request, checked. Null for anything else. */
export function readPreviewRequest(value: unknown): ReadPreviewRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? oneLine(raw.title).slice(0, 300) : '';
  const theme = raw.theme && typeof raw.theme === 'object' ? { theme: raw.theme } : {};
  if (raw.source === 'page') return { source: 'page', title, ...theme };
  if (raw.source === 'window') return isPrintFrameName(raw.name as string | undefined) ? { source: 'window', name: raw.name as string, title, ...theme } : null;
  if (raw.source === 'pdf') {
    const data = raw.data instanceof Uint8Array ? raw.data : raw.data instanceof ArrayBuffer ? new Uint8Array(raw.data) : null;
    return data && data.byteLength > 0 ? { source: 'pdf', data, title, ...theme } : null;
  }
  return null;
}

export const PRINT_FRAME_NAME = /^bulwark-print-[a-z0-9-]{1,60}$/;

export function isPrintFrameName(name: string | undefined): boolean {
  return typeof name === 'string' && PRINT_FRAME_NAME.test(name);
}
