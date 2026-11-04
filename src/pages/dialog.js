// The dialog window's page. build.mjs puts this inline in dialog.html, allowed by its hash.
// Everything from the spec goes in as textContent: no markup from a page or a plugin is ever parsed.

const ICONS = {
  puzzle: ['M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1'],
  dots: ['M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
  power: ['M7 6a7.75 7.75 0 1 0 10 0', 'M12 4l0 8'],
  warning: ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0', 'M12 16h.01'],
};
const CSS_NAMES = {
  background: '--background', foreground: '--foreground', muted: '--muted', mutedForeground: '--muted-foreground',
  border: '--border', input: '--input', primary: '--primary', primaryForeground: '--primary-foreground',
  destructive: '--destructive', destructiveForeground: '--destructive-foreground', accent: '--accent',
  accentForeground: '--accent-foreground', ring: '--ring',
};

const byId = (id) => document.getElementById(id);

function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

let answered = false;
function answer(value) {
  if (answered) return;
  answered = true;
  window.bulwarkDialog.answer(value);
}

function applyLook(spec) {
  const root = document.documentElement;
  root.lang = spec.lang;
  root.dir = spec.dir;
  root.classList.toggle('dark', spec.theme.dark);
  root.style.colorScheme = spec.theme.dark ? 'dark' : 'light';
  for (const [key, name] of Object.entries(CSS_NAMES)) root.style.setProperty(name, spec.theme.colours[key]);
  root.style.setProperty('--font', spec.theme.font);
  root.style.setProperty('--radius', `${spec.theme.radius}px`);
  root.style.setProperty('--radius-sm', `${spec.theme.radiusSmall}px`);
  root.style.fontSize = `${spec.theme.fontSize}px`;
}

function buildMenu(spec, head) {
  const wrap = document.createElement('div');
  wrap.className = 'menu-wrap';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'icon';
  toggle.id = 'menu-button';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', spec.menu.label);
  toggle.title = spec.menu.label;
  toggle.append(icon('dots', 20));
  const list = document.createElement('div');
  list.className = 'menu';
  list.setAttribute('role', 'menu');
  list.hidden = true;
  for (const item of spec.menu.items) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = item.destructive ? 'item danger' : 'item';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    if (item.destructive) entry.append(icon('power', 16));
    const label = document.createElement('span');
    label.textContent = item.label;
    entry.append(label);
    entry.addEventListener('click', () => answer({ menu: item.id }));
    list.append(entry);
  }
  const items = () => [...list.querySelectorAll('.item')];
  const setOpen = (open) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) items()[0]?.focus();
  };
  toggle.addEventListener('click', () => setOpen(list.hidden));
  list.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      all[(at + (event.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('mousedown', (event) => {
    if (!list.hidden && !wrap.contains(event.target)) setOpen(false);
  }, true);
  wrap.append(toggle, list);
  head.append(wrap);
  return { isOpen: () => !list.hidden, close: () => { setOpen(false); toggle.focus(); } };
}

async function main() {
  const spec = await window.bulwarkDialog.spec();
  if (!spec) return;
  applyLook(spec);
  document.title = spec.title;
  const card = byId('card');
  const head = byId('head');
  byId('title').textContent = spec.title;

  if (spec.icon === 'warning') {
    card.classList.add('with-icon');
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.append(icon('warning', 20));
    head.prepend(badge);
  }
  if (spec.source) {
    // Who is asking, in the shell's own line: the text above and below is the caller's.
    card.classList.add('with-source');
    const source = document.createElement('p');
    source.className = 'source';
    source.dataset.dialogSource = '';
    const name = document.createElement('span');
    name.textContent = spec.source;
    source.append(icon('puzzle', 12), name);
    head.querySelector('.heading').append(source);
  }
  const menu = spec.menu ? buildMenu(spec, head) : null;

  const message = byId('message');
  for (const run of spec.message) {
    if (run.bold) {
      const strong = document.createElement('strong');
      strong.textContent = run.text;
      message.append(strong);
    } else {
      message.append(document.createTextNode(run.text));
    }
  }
  if (spec.message.length > 0) {
    card.setAttribute('aria-describedby', 'message');
  } else {
    byId('body').remove();
  }

  const foot = byId('foot');
  const buttons = spec.buttons.map((spec, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${spec.variant}`;
    button.textContent = spec.label;
    button.dataset.index = String(index);
    button.addEventListener('click', () => answer({ button: index }));
    foot.append(button);
    return button;
  });
  const fallback = buttons[spec.defaultIndex];

  // A long text scrolls between the title and the buttons; a stop for Tab so the arrow keys can scroll it.
  const body = byId('body');
  const scrollable = () => Boolean(body) && body.scrollHeight - body.clientHeight > 2;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (menu?.isOpen()) menu.close();
      else answer(null);
      return;
    }
    if (event.key === 'Enter' && !event.isComposing) {
      // On a button Enter is that button's, as Space is.
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      fallback.click();
      return;
    }
    if (event.key === 'Tab') {
      // Tab goes round the card and nowhere else.
      const stops = [...card.querySelectorAll('button:not([tabindex="-1"]), [tabindex="0"]')].filter((el) => el.offsetParent !== null);
      if (stops.length === 0) return;
      const at = stops.indexOf(document.activeElement);
      event.preventDefault();
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
      stops[next].focus();
    }
  });

  await document.fonts?.ready;
  if (body && scrollable()) body.tabIndex = 0;
  fallback.focus();
  const box = card.getBoundingClientRect();
  // A pixel more: the window's size is rounded to the screen's pixels, and a pixel less would make the text scroll.
  window.bulwarkDialog.ready({ width: Math.ceil(box.width), height: Math.ceil(box.height) + 1 });
  // Clamped to the screen: the body scrolls now, so it takes Tab.
  window.addEventListener('resize', () => {
    if (body) body.tabIndex = scrollable() ? 0 : -1;
  });
}

void main();
