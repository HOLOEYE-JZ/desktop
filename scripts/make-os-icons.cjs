// Makes the tray and thumbnail toolbar icons in assets/os from the logo. Run by hand when
// the mark changes; the results are committed, so a build needs nothing of this.
//
//   node scripts/run-electron.mjs scripts/make-os-icons.cjs --logo <Bulwark_Logo_White.svg>
//
// A hidden, transparent window draws the SVG at each size: Chromium is the one SVG
// renderer this repo has, and these need to look right at 16 px.

const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'assets', 'os');
const logoFile = process.argv[process.argv.indexOf('--logo') + 1];
const logoBody = readFileSync(logoFile, 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--.*?-->/gs, '');

// The same glyphs the webmail's Tabler icons draw.
const TABLER = {
  compose: ['M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4', 'M13.5 6.5l4 4'],
  inbox: ['M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z', 'M4 13h3l3 3h4l3 -3h3'],
};

function logo(colour) {
  return logoBody.replace(/rgb\(255,255,255\)/g, colour).replace(/width="1000pt" height="1000pt"/, 'width="100%" height="100%"');
}

function glyph(paths, colour) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

const JOBS = [];
// Windows: the sizes of a 16 px icon at 100% to 300% scale. Linux: 22 and 44.
for (const size of [16, 20, 22, 24, 32, 40, 44, 48]) {
  JOBS.push({ name: `tray-light-${size}.png`, size, svg: logo('rgb(255,255,255)') }); // On a dark taskbar.
  JOBS.push({ name: `tray-dark-${size}.png`, size, svg: logo('rgb(24,24,27)') }); // On a light one.
}
JOBS.push({ name: 'trayTemplate.png', size: 16, svg: logo('rgb(0,0,0)') });
JOBS.push({ name: 'trayTemplate@2x.png', size: 32, svg: logo('rgb(0,0,0)') });
for (const size of [16, 24, 32]) {
  JOBS.push({ name: `thumb-compose-${size}.png`, size, svg: glyph(TABLER.compose, '#ffffff') });
  JOBS.push({ name: `thumb-inbox-${size}.png`, size, svg: glyph(TABLER.inbox, '#ffffff') });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 64, height: 64, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true } });
  for (const job of JOBS) {
    window.setContentSize(job.size, job.size);
    const html = `<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent;width:${job.size}px;height:${job.size}px;overflow:hidden">${job.svg}</body></html>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: job.size, height: job.size });
    const fitted = image.getSize().width === job.size ? image : image.resize({ width: job.size, height: job.size, quality: 'best' });
    writeFileSync(path.join(OUT, job.name), fitted.toPNG());
  }
  console.log(`${JOBS.length} icons in ${OUT}`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
