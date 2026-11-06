// The print preview's page. build.mjs puts this inline in print.html, allowed by its hash.
// Text from main goes in as textContent. The pages are a PDF main made, shown as a blob in
// Chromium's PDF viewer: a frame of its own, without this page's bridge.

const PAPERS = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'];
const CSS_NAMES = {
  background: '--background', foreground: '--foreground', muted: '--muted', mutedForeground: '--muted-foreground',
  border: '--border', input: '--input', primary: '--primary', primaryForeground: '--primary-foreground',
  destructive: '--destructive', destructiveForeground: '--destructive-foreground', accent: '--accent',
  accentForeground: '--accent-foreground', ring: '--ring',
};
/** The viewer without its toolbar, each sheet whole. */
const VIEWER_FRAGMENT = '#toolbar=0&navpanes=0&view=Fit';
/** Quiet time after a change before the pages are made again. */
const DEBOUNCE_MS = 250;

const api = window.bulwarkPrint;
const byId = (id) => document.getElementById(id);

let spec = null;
let text = {};
let choices = null;
let renderSeq = 0;
let renderTimer = 0;
/** What the pages on screen were made from: a change to copies or colour alone needs no new pages. */
let shownKey = null;
let pagesValid = false;
let rendered = false;
let busy = false;

function t(key, values) {
  const value = text[key] ?? key;
  return values ? value.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : value;
}

function applyLook(look, lang, dir) {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = dir;
  root.classList.toggle('dark', look.dark);
  root.style.colorScheme = look.dark ? 'dark' : 'light';
  for (const [key, name] of Object.entries(CSS_NAMES)) root.style.setProperty(name, look.colours[key]);
  root.style.setProperty('--font', look.font);
  root.style.setProperty('--radius', `${look.radius}px`);
  root.style.setProperty('--radius-sm', `${look.radiusSmall}px`);
  root.style.fontSize = `${look.fontSize}px`;
}

function setText(id, key) {
  byId(id).textContent = t(key);
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function isPdf() {
  return choices?.destination.kind === 'pdf';
}

function destinationValue(destination) {
  if (destination.kind === 'pdf') return 'pdf';
  const index = spec.printers.findIndex((printer) => printer.name === destination.name);
  return index >= 0 ? `printer:${index}` : '';
}

function destinationOf(value) {
  if (value === 'pdf') return { kind: 'pdf' };
  const printer = spec.printers[Number(value.slice('printer:'.length))];
  return printer ? { kind: 'printer', name: printer.name } : null;
}

function fillPaper() {
  const paper = byId('paper');
  paper.replaceChildren();
  if (!isPdf()) paper.append(option('printer', t('printPaperPrinter')));
  for (const size of PAPERS) paper.append(option(size, size));
}

/** The controls show `choices`. */
function showChoices() {
  byId('destination').value = destinationValue(choices.destination);
  fillPaper();
  const custom = choices.pages.trim() !== '';
  byId('pages-mode').value = custom ? 'custom' : 'all';
  byId('pages').hidden = !custom;
  byId('pages').value = choices.pages;
  byId('copies').value = String(choices.copies);
  byId('layout').value = choices.landscape ? 'landscape' : 'portrait';
  byId('color').value = choices.color ? 'color' : 'mono';
  byId('paper').value = choices.paper;
  byId('margins').value = choices.margins;
  byId('scale').value = String(choices.scale);
  byId('header-footer').checked = choices.headerFooter;
  byId('background').checked = choices.background;
  // Save as PDF has one copy and keeps the colours. A PDF keeps its own margins and lines.
  byId('copies-field').hidden = isPdf();
  byId('color-field').hidden = isPdf();
  const pdfSource = spec.kind === 'pdf';
  byId('margins-field').hidden = pdfSource;
  byId('options-field').hidden = pdfSource;
  byId('system').hidden = spec.printers.length === 0;
  byId('go').textContent = isPdf() ? t('printSave') : t('printPrint');
  byId('preview').classList.toggle('mono', !choices.color && !isPdf());
}

function clampNumber(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && String(value).trim() !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

/** `choices` from the controls. */
function readChoices() {
  const custom = byId('pages-mode').value === 'custom';
  choices = {
    destination: destinationOf(byId('destination').value) ?? choices.destination,
    pages: custom ? byId('pages').value : '',
    copies: clampNumber(byId('copies').value, 1, 99, 1),
    landscape: byId('layout').value === 'landscape',
    color: byId('color').value !== 'mono',
    paper: byId('paper').value || choices.paper,
    margins: byId('margins').value,
    scale: clampNumber(byId('scale').value, 10, 200, 100),
    headerFooter: byId('header-footer').checked,
    background: byId('background').checked,
  };
  byId('preview').classList.toggle('mono', !choices.color && !isPdf());
}

function renderKey(c) {
  const { copies, color, destination, ...rest } = c;
  return JSON.stringify({ ...rest, pdf: destination.kind === 'pdf', paperFor: destination.kind === 'printer' ? destination.name : '' });
}

function setGoEnabled() {
  byId('go').disabled = busy || !rendered || !pagesValid;
}

function schedule(delay) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, delay);
}

function setStatus(message, over) {
  const status = byId('status');
  status.textContent = message;
  status.classList.toggle('over', Boolean(over));
}

let frontFrame = byId('frame-a');
let backFrame = byId('frame-b');
const frameUrls = new WeakMap();

/** The new pages load behind the old ones and take their place once drawn: no blank flash. */
function showPdf(data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  const next = backFrame;
  const previous = frontFrame;
  next.addEventListener('load', () => {
    setTimeout(() => {
      next.classList.add('front');
      previous.classList.remove('front');
      const old = frameUrls.get(previous);
      if (old) URL.revokeObjectURL(old);
      frameUrls.delete(previous);
      previous.removeAttribute('src');
      frontFrame = next;
      backFrame = previous;
      setStatus('');
    }, 120);
  }, { once: true });
  frameUrls.set(next, url);
  next.src = url + VIEWER_FRAGMENT;
}

async function renderNow() {
  if (!choices) return;
  const key = renderKey(choices);
  if (key === shownKey && rendered) {
    setGoEnabled();
    return;
  }
  const seq = ++renderSeq;
  setStatus(t('printPreparing'), rendered);
  const result = await api.render(choices);
  if (seq !== renderSeq) return;
  const pagesInput = byId('pages');
  if (result && result.ok) {
    pagesValid = true;
    rendered = true;
    shownKey = key;
    pagesInput.removeAttribute('aria-invalid');
    byId('pages-error').textContent = '';
    byId('count').textContent = result.pages === 1 ? t('printPagesOne') : t('printPagesMany', { count: result.pages });
    showPdf(result.data);
  } else if (result && result.error === 'pages') {
    pagesValid = false;
    pagesInput.setAttribute('aria-invalid', 'true');
    byId('pages-error').textContent = t('printPagesInvalid', { count: result.total });
    setStatus('');
  } else {
    setStatus(t('printPreviewFailed'));
  }
  setGoEnabled();
}

async function go() {
  readChoices();
  if (byId('go').disabled) return;
  busy = true;
  setGoEnabled();
  const done = await api.run(isPdf() ? 'save' : 'print', choices);
  // Still here: the save dialog was closed, or the pages aren't there.
  if (!done) {
    busy = false;
    setGoEnabled();
  }
}

function onChange() {
  readChoices();
  setGoEnabled();
  schedule(DEBOUNCE_MS);
}

async function onDestination() {
  const destination = destinationOf(byId('destination').value);
  if (!destination) return;
  // What this destination had last, else what is chosen now. This print's pages stay.
  const fresh = await api.choicesFor(destination, choices);
  if (!fresh) return;
  choices = fresh;
  showChoices();
  setGoEnabled();
  schedule(0);
}

async function main() {
  spec = await api.spec();
  if (!spec) return;
  text = spec.text;
  applyLook(spec.theme, spec.lang, spec.dir);
  document.title = t('printTitle');
  setText('title', 'printTitle');
  setText('destination-label', 'printDestination');
  setText('pages-label', 'printPages');
  setText('pages-all', 'printPagesAll');
  setText('pages-custom', 'printPagesCustom');
  byId('pages').placeholder = t('printPagesExample');
  byId('pages').setAttribute('aria-label', t('printPagesCustom'));
  setText('copies-label', 'printCopies');
  setText('layout-label', 'printLayout');
  setText('layout-portrait', 'printPortrait');
  setText('layout-landscape', 'printLandscape');
  setText('color-label', 'printColor');
  setText('color-color', 'printColorColor');
  setText('color-mono', 'printColorMono');
  setText('more-label', 'printMore');
  setText('paper-label', 'printPaper');
  setText('margins-label', 'printMargins');
  setText('margins-default', 'printMarginsDefault');
  setText('margins-none', 'printMarginsNone');
  setText('margins-minimum', 'printMarginsMinimum');
  setText('scale-label', 'printScale');
  setText('options-label', 'printOptions');
  setText('header-footer-label', 'printHeaderFooter');
  setText('background-label', 'printBackground');
  setText('system', 'printSystemDialog');
  setText('cancel', 'printCancel');
  byId('preview').setAttribute('aria-label', t('printPreviewLabel'));
  byId('frame-a').title = t('printPreviewLabel');
  byId('frame-b').title = t('printPreviewLabel');

  const destination = byId('destination');
  spec.printers.forEach((printer, index) => destination.append(option(`printer:${index}`, printer.displayName)));
  if (spec.pdf) destination.append(option('pdf', t('printSaveAsPdf')));
  choices = spec.choices;
  showChoices();

  destination.addEventListener('change', () => void onDestination());
  byId('pages-mode').addEventListener('change', () => {
    const custom = byId('pages-mode').value === 'custom';
    byId('pages').hidden = !custom;
    if (custom) byId('pages').focus();
    onChange();
  });
  byId('pages').addEventListener('input', onChange);
  for (const id of ['copies', 'layout', 'color', 'paper', 'margins', 'scale', 'header-footer', 'background']) {
    byId(id).addEventListener(id === 'copies' || id === 'scale' ? 'input' : 'change', onChange);
  }
  byId('more-toggle').addEventListener('click', () => {
    const open = byId('more').hidden;
    byId('more').hidden = !open;
    byId('more-toggle').setAttribute('aria-expanded', String(open));
  });
  byId('go').addEventListener('click', () => void go());
  byId('cancel').addEventListener('click', () => void api.run('cancel'));
  byId('system').addEventListener('click', () => void api.run('system'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void api.run('cancel');
      return;
    }
    if (event.key === 'Enter' && !event.isComposing) {
      // On a button Enter is that button's, as Space is.
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      void go();
    }
  });

  await document.fonts?.ready;
  byId('go').focus();
  api.ready();
  schedule(0);
}

void main();
