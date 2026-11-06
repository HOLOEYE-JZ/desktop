import { expect, test } from '@playwright/test';
import { LABEL_KEY, labelKeepsPlaceholders } from '../src/main/label-keys';
import {
  countPdfPages,
  defaultChoices,
  devicePrintOptions,
  initialDestination,
  localPaper,
  parsePageRanges,
  pdfOptions,
  pdfPageRanges,
  previewBounds,
  printerPaper,
  readPreviewRequest,
  readPrintChoices,
  remember,
  rememberedFor,
  sortPrinters,
  switchDestination,
  windowsDefaultPrinter,
  LIMITS,
  type PrintChoices,
  type PrinterEntry,
} from '../src/main/print-rules';

const PRINTERS: PrinterEntry[] = [
  { name: 'Office Laser', displayName: 'Office Laser', isDefault: true },
  { name: 'Label Printer', displayName: 'Label Printer', isDefault: false },
];
const ALLOWED = { print: true, pdf: true };
const office: PrintChoices = defaultChoices({ kind: 'printer', name: 'Office Laser' }, undefined, 'A4');

test('page ranges read as Chrome reads them, and name only pages that are there', () => {
  expect(parsePageRanges('', 5)).toEqual([[1, 5]]);
  expect(parsePageRanges('  ', 5)).toEqual([[1, 5]]);
  expect(parsePageRanges('1-3, 5', 5)).toEqual([[1, 3], [5, 5]]);
  expect(parsePageRanges('5, 1-2', 5)).toEqual([[1, 2], [5, 5]]);
  // Overlapping and touching ranges merge.
  expect(parsePageRanges('1-2,2-3,4', 5)).toEqual([[1, 4]]);
  expect(parsePageRanges('3-', 5)).toEqual([[3, 5]]);
  expect(parsePageRanges('-2', 5)).toEqual([[1, 2]]);
  expect(parsePageRanges('1;3', 5)).toEqual([[1, 1], [3, 3]]);
  for (const wrong of ['0', '6', '2-9', '3-1', 'a', '1-2-3', '1 2', '-', ',', '1.5']) expect(parsePageRanges(wrong, 5), wrong).toBeNull();
  expect(parsePageRanges('1', 0)).toBeNull();
});

test('ranges go to printToPDF 1-based and to print 0-based', () => {
  const ranges = parsePageRanges('1-3, 5', 9)!;
  expect(pdfPageRanges(ranges)).toBe('1-3,5');
  const options = devicePrintOptions({ ...office, pages: '1-3, 5' }, ranges, 9, 'Hello')!;
  expect(options.pageRanges).toEqual([{ from: 0, to: 2 }, { from: 4, to: 4 }]);
  // Every page: no range at all, so the printer gets the whole document.
  expect(devicePrintOptions(office, parsePageRanges('', 9)!, 9, 'Hello')!.pageRanges).toBeUndefined();
  expect(devicePrintOptions(office, parsePageRanges('1-9', 9)!, 9, 'Hello')!.pageRanges).toBeUndefined();
});

test('the chosen options become webContents.print options for that printer, silent', () => {
  const choices: PrintChoices = { ...office, copies: 3, landscape: true, color: false, paper: 'Letter', margins: 'minimum', scale: 80, headerFooter: true, background: false };
  expect(devicePrintOptions(choices, [[1, 4]], 4, 'Quarterly report')).toEqual({
    silent: true,
    deviceName: 'Office Laser',
    copies: 3,
    collate: true,
    landscape: true,
    color: false,
    printBackground: false,
    scaleFactor: 80,
    margins: { marginType: 'printableArea' },
    pageSize: 'Letter',
    header: 'Quarterly report',
    footer: '',
  });
  const plain = devicePrintOptions(office, [[1, 1]], 1, '')!;
  expect(plain).toMatchObject({ usePrinterDefaultPageSize: true, margins: { marginType: 'default' }, color: true, printBackground: true, scaleFactor: 100 });
  expect(plain.pageSize).toBeUndefined();
  expect(plain.header).toBeUndefined();
  // Save as PDF isn't printed.
  expect(devicePrintOptions({ ...office, destination: { kind: 'pdf' } }, [[1, 1]], 1, '')).toBeNull();
});

test('the preview is printToPDF with the same layout: orientation, paper, margins, scale, header lines', () => {
  const html = { paper: 'A4' as const, title: 'Report <b>', date: '6.11.2026', source: 'html' as const };
  const base = pdfOptions(office, html);
  expect(base).toEqual({ landscape: false, printBackground: true, scale: 1, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, displayHeaderFooter: false });
  expect(pdfOptions({ ...office, landscape: true }, html).landscape).toBe(true);
  expect(pdfOptions({ ...office, paper: 'Legal' }, html).pageSize).toBe('Legal');
  expect(pdfOptions({ ...office, margins: 'none' }, html).margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  expect(pdfOptions({ ...office, scale: 150 }, html).scale).toBe(1.5);
  const lines = pdfOptions({ ...office, headerFooter: true, margins: 'none' }, html);
  expect(lines.displayHeaderFooter).toBe(true);
  // The title is text in the header, never markup.
  expect(lines.headerTemplate).toContain('Report &#60;b&#62;');
  expect(lines.headerTemplate).toContain('6.11.2026');
  expect(lines.footerTemplate).toContain('pageNumber');
  expect(lines.margins.top).toBe(0.4);
  // A PDF keeps its own margins and has no header lines of ours.
  const pdf = pdfOptions({ ...office, headerFooter: true }, { ...html, source: 'pdf' });
  expect(pdf.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  expect(pdf.displayHeaderFooter).toBe(false);
});

test('choices from the page are checked: only listed printers, numbers in range, a PDF is one copy in colour', () => {
  const context = { printers: PRINTERS, allowed: ALLOWED };
  expect(readPrintChoices({ ...office, destination: { kind: 'printer', name: 'Somebody Else' } }, context)).toBeNull();
  expect(readPrintChoices({ ...office, destination: { kind: 'printer', name: 'Office Laser' } }, { printers: PRINTERS, allowed: { print: false, pdf: true } })).toBeNull();
  expect(readPrintChoices({ ...office, destination: { kind: 'pdf' } }, { printers: PRINTERS, allowed: { print: true, pdf: false } })).toBeNull();
  expect(readPrintChoices({ ...office, paper: 'Napkin' }, context)).toBeNull();
  const clamped = readPrintChoices({ ...office, copies: 5000, scale: 1, pages: 'x'.repeat(500) }, context)!;
  expect(clamped.copies).toBe(LIMITS.copies);
  expect(clamped.scale).toBe(LIMITS.scaleMin);
  expect(clamped.pages).toHaveLength(LIMITS.pagesText);
  expect(readPrintChoices({ ...office, copies: 2.5 }, context)!.copies).toBe(1);
  const pdf = readPrintChoices({ ...office, destination: { kind: 'pdf' }, paper: 'A4', copies: 4, color: false }, context)!;
  expect(pdf.copies).toBe(1);
  expect(pdf.color).toBe(true);
  // "The printer's own paper" is no size for a PDF.
  expect(readPrintChoices({ ...office, destination: { kind: 'pdf' }, paper: 'printer' }, context)).toBeNull();
  expect(readPrintChoices('print everything', context)).toBeNull();
});

test('choices are remembered per destination, the oldest dropped past the limit, and not pages or copies', () => {
  let memory = remember(undefined, { ...office, landscape: true, copies: 7, pages: '2' });
  expect(memory.last).toBe('printer:Office Laser');
  expect(rememberedFor(memory, { kind: 'printer', name: 'Office Laser' })).toEqual({ landscape: true, color: true, paper: 'printer', margins: 'default', scale: 100, headerFooter: false, background: true });
  expect(rememberedFor(memory, { kind: 'printer', name: 'Label Printer' })).toBeUndefined();
  const next = defaultChoices({ kind: 'printer', name: 'Office Laser' }, rememberedFor(memory, { kind: 'printer', name: 'Office Laser' }), 'A4');
  expect(next).toMatchObject({ landscape: true, copies: 1, pages: '' });
  for (let i = 0; i < LIMITS.remembered + 5; i += 1) memory = remember(memory, { ...office, destination: { kind: 'printer', name: `P${i}` } });
  expect(Object.keys(memory.byDestination)).toHaveLength(LIMITS.remembered);
  expect(rememberedFor(memory, { kind: 'printer', name: 'Office Laser' })).toBeUndefined();
  // A damaged file gives defaults, not a crash.
  expect(rememberedFor({ byDestination: { pdf: { paper: 'printer', scale: 'big' } as never } }, { kind: 'pdf' })).toBeUndefined();
});

test('a new preview starts on the last destination if it is still there, else the default printer', () => {
  expect(initialDestination(PRINTERS, undefined, ALLOWED)).toEqual({ kind: 'printer', name: 'Office Laser' });
  expect(initialDestination(PRINTERS, { last: 'printer:Label Printer', byDestination: {} }, ALLOWED)).toEqual({ kind: 'printer', name: 'Label Printer' });
  expect(initialDestination(PRINTERS, { last: 'printer:Gone', byDestination: {} }, ALLOWED)).toEqual({ kind: 'printer', name: 'Office Laser' });
  expect(initialDestination(PRINTERS, { last: 'pdf', byDestination: {} }, ALLOWED)).toEqual({ kind: 'pdf' });
  expect(initialDestination(PRINTERS, { last: 'pdf', byDestination: {} }, { print: true, pdf: false })).toEqual({ kind: 'printer', name: 'Office Laser' });
  expect(initialDestination([], undefined, ALLOWED)).toEqual({ kind: 'pdf' });
  expect(initialDestination(PRINTERS, undefined, { print: false, pdf: false })).toBeNull();
});

test('picking another destination brings its own choices, or keeps what is chosen now', () => {
  const now: PrintChoices = { ...office, landscape: true, copies: 2, pages: '1-2', color: false };
  const kept = switchDestination(now, { kind: 'printer', name: 'Label Printer' }, undefined, 'A4');
  expect(kept).toMatchObject({ destination: { kind: 'printer', name: 'Label Printer' }, landscape: true, copies: 2, pages: '1-2', color: false });
  const own = switchDestination(now, { kind: 'printer', name: 'Label Printer' }, { ...office, landscape: false }, 'A4');
  expect(own).toMatchObject({ landscape: false, copies: 2, pages: '1-2' });
  const pdf = switchDestination(now, { kind: 'pdf' }, undefined, 'Letter');
  expect(pdf).toMatchObject({ destination: { kind: 'pdf' }, paper: 'Letter', copies: 1, color: true, pages: '1-2' });
});

test('printers: the default first, then by name; Windows names it in the registry, CUPS in printer-type', () => {
  const list = [
    { name: 'Zebra', displayName: 'Zebra', options: {} },
    { name: 'Canon', displayName: 'Canon', options: {} },
    { name: 'Brother', displayName: 'Brother', options: {} },
    { name: 'Canon', displayName: 'Canon again', options: {} },
    { name: '', displayName: 'Nameless' },
  ];
  expect(sortPrinters(list, 'Zebra').map((p) => [p.name, p.isDefault])).toEqual([['Zebra', true], ['Brother', false], ['Canon', false]]);
  expect(sortPrinters(list, null).every((p) => !p.isDefault)).toBe(true);
  const cups = [{ name: 'a', options: { 'printer-type': '8425484' } }, { name: 'b', options: { 'printer-type': String(8425484 | 0x20000) } }];
  expect(sortPrinters(cups, null)[0]).toMatchObject({ name: 'b', isDefault: true });
  // A name shown in the list is one line.
  expect(sortPrinters([{ name: 'x', displayName: 'Evil‮printer\nname' }], null)[0].displayName).toBe('Evil printer name');
  expect(windowsDefaultPrinter('Office Laser,winspool,Ne01:')).toBe('Office Laser');
  expect(windowsDefaultPrinter('')).toBeNull();
  expect(windowsDefaultPrinter(null)).toBeNull();
});

test('paper: the printer says where it can, else the country decides', () => {
  expect(printerPaper({ media: 'iso_a4_210x297mm' })).toBe('A4');
  expect(printerPaper({ media: 'na_letter_8.5x11in' })).toBe('Letter');
  expect(printerPaper({ media: 'na_legal_8.5x14in' })).toBe('Legal');
  expect(printerPaper({})).toBeNull();
  expect(printerPaper(undefined)).toBeNull();
  expect(localPaper('US')).toBe('Letter');
  expect(localPaper('ca')).toBe('Letter');
  expect(localPaper('DE')).toBe('A4');
  expect(localPaper(undefined)).toBe('A4');
});

test('a page count from the PDF, also when the page objects are packed away', () => {
  expect(countPdfPages(Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> << /Type /Page >> << /Type/Page /Parent 2 0 R >>'))).toBe(2);
  expect(countPdfPages(Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 7 >>'))).toBe(7);
  expect(countPdfPages(new Uint8Array())).toBe(0);
});

test('a page asks for a preview of itself, of a print window of its own, or of a PDF, and nothing else', () => {
  expect(readPreviewRequest({ source: 'page', title: 'Hello\nthere' })).toEqual({ source: 'page', title: 'Hello there' });
  expect(readPreviewRequest({ source: 'window', name: 'bulwark-print-abc123' })).toMatchObject({ source: 'window', name: 'bulwark-print-abc123' });
  expect(readPreviewRequest({ source: 'window', name: 'bulwark-dialog-x' })).toBeNull();
  expect(readPreviewRequest({ source: 'window', name: '_blank' })).toBeNull();
  expect(readPreviewRequest({ source: 'pdf', data: new Uint8Array([37, 80]) })).toMatchObject({ source: 'pdf' });
  expect(readPreviewRequest({ source: 'pdf', data: new Uint8Array() })).toBeNull();
  expect(readPreviewRequest({ source: 'pdf', data: 'JVBERi0=' })).toBeNull();
  expect(readPreviewRequest({ source: 'url', url: 'https://evil.example' })).toBeNull();
  expect(readPreviewRequest(null)).toBeNull();
});

test('the window fits the screen and stands over its parent', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  expect(previewBounds({ x: 200, y: 100, width: 1200, height: 800 }, work)).toEqual({ x: 248, y: 88, width: 1104, height: 824 });
  // A small screen: the window is the screen's size, never more.
  expect(previewBounds({ x: 0, y: 0, width: 1000, height: 700 }, { x: 0, y: 0, width: 1024, height: 720 })).toEqual({ x: 0, y: 0, width: 1024, height: 720 });
});

test('the webmail may translate the preview, keeping its numbers', () => {
  expect(LABEL_KEY.test('printTitle')).toBe(true);
  expect(labelKeepsPlaceholders('printPagesMany', '{count} Seiten')).toBe(true);
  expect(labelKeepsPlaceholders('printPagesMany', 'Seiten')).toBe(false);
  expect(labelKeepsPlaceholders('printPagesInvalid', 'Seiten 1 bis {count}')).toBe(true);
});
