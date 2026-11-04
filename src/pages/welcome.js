// build.mjs puts src/pages/welcome-strings.json here: the page is a data: page, its script inline.
const STRINGS = __WELCOME_STRINGS__;
const RTL = ['ar', 'fa', 'he'];

/** The first of the system's languages the page has, by full tag, then by language. */
function pickLanguage(languages) {
  const codes = Object.keys(STRINGS);
  for (const raw of languages) {
    const tag = String(raw || '').toLowerCase();
    if (!tag) continue;
    const exact = codes.find((code) => code.toLowerCase() === tag);
    if (exact) return exact;
    if (/^zh-(?:tw|hk|mo|hant)/.test(tag)) return 'zh-TW';
    if (/^(?:no|nn)(?:-|$)/.test(tag)) return 'nb';
    const base = codes.find((code) => code.toLowerCase() === tag.split('-')[0]);
    if (base) return base;
  }
  return 'en';
}

const language = pickLanguage([navigator.language, ...(navigator.languages || [])]);
const text = STRINGS[language];
document.documentElement.lang = language;
document.documentElement.dir = RTL.includes(language) ? 'rtl' : 'ltr';

const byId = (id) => document.getElementById(id);
const fill = { 'privacy-title': 'privacyTitle', 'privacy-intro': 'privacyIntro', 'telemetry-label': 'telemetryLabel', 'telemetry-text': 'telemetryText', 'crash-label': 'crashLabel', 'crash-text': 'crashText', continue: 'continueLabel', back: 'back', title: 'title', intro: 'intro', 'email-label': 'emailLabel', standalone: 'continueLabel', instance: 'orgLink', 'instance-title': 'instanceTitle', 'instance-text': 'instanceText', 'url-label': 'urlLabel', 'org-back': 'back', connect: 'connect' };
for (const [id, key] of Object.entries(fill)) byId(id).textContent = text[key];
document.title = text.title;

const { allowStandalone, instanceUrl, urlLocked, askTelemetry, askCrashReports } = window.bulwarkWelcome.options;
const ERRORS = { policy: 'policy', insecure: 'insecure', email: 'email', no_jmap: 'noJmap', unreachable: 'unreachable', not_bulwark: 'notBulwark', email_invalid: 'emailInvalid', web_address: 'webAddress' };
/** The latest choice sent to main: an earlier answer arriving late is ignored. */
let request = 0;

if (!askTelemetry) byId('telemetry-row').remove();
if (!askCrashReports) byId('crash-row').remove();

/**
 * Two screens before the privacy step: the email address, and the organisation's Bulwark
 * address behind a link. Without the first (a policy), the second has no Back.
 */
let screen = 'connection';
function setHidden(id, hidden) {
  const element = byId(id);
  if (element) element.hidden = hidden;
}
function show(name) {
  // A line under a field is about what was typed on that step, not the next time it shows.
  if (name !== screen) {
    setError('email', null);
    setError('url', null);
  }
  screen = name;
  setHidden('connection', name !== 'connection');
  setHidden('org', name !== 'org');
  document.title = name === 'org' ? text.instanceTitle : text.title;
  byId(name === 'org' ? 'url' : 'email').focus();
}

/** The mode is chosen: the second question, if there is one. Main says. */
function next(result) {
  if (result.next !== 'privacy') return;
  setHidden('connection', true);
  setHidden('org', true);
  document.title = text.privacyTitle;
  byId('privacy').classList.add('open');
  byId('continue').focus();
}

// Back to where the choice was made. Choosing again there asks main again, which replaces the earlier choice.
byId('back').addEventListener('click', () => {
  byId('privacy').classList.remove('open');
  show(screen);
});

byId('privacy').addEventListener('submit', (event) => {
  event.preventDefault();
  void window.bulwarkWelcome.answerPrivacy({
    telemetry: byId('telemetry')?.checked === true,
    crashReports: byId('crash')?.checked === true,
  });
});

/** Each field's line under it. */
const ERROR_BOX = { email: 'email-error', url: 'error' };
/** What an error offers next to its text: Gmail and the like get where to read what works. */
const ERROR_LINKS = {
  noJmap: { label: 'learnMore', run: () => window.bulwarkWelcome.openLink('providers') },
  // A web address in the email field: the organisation's step, with it filled in.
  webAddress: {
    label: 'webAddressLink',
    run: () => {
      if (!urlLocked) byId('url').value = byId('email').value.trim();
      show('org');
    },
  },
};

/** The line under a field, with its link if it has one. Null clears it. */
function setError(field, key) {
  const box = ERROR_BOX[field];
  // Without the email step (a policy), its field isn't there.
  if (!byId(box)) return;
  byId(`${box}-text`).textContent = key ? text[key] : '';
  const link = key ? ERROR_LINKS[key] : undefined;
  const button = byId(`${box}-link`);
  button.hidden = !link;
  button.textContent = link ? text[link.label] : '';
  button.onclick = link ? () => link.run(field) : null;
  byId(box).hidden = !key;
  if (key) byId(field).setAttribute('aria-invalid', 'true');
  else byId(field).removeAttribute('aria-invalid');
}

/** An answer from main: the text under the field, or on to the next step. */
function answer(result, field) {
  if (!result.ok) {
    setError(field, ERRORS[result.error] ?? 'invalid');
    byId(field).focus();
  } else next(result);
}

for (const field of ['email', 'url']) byId(field).addEventListener('input', () => setError(field, null));

if (instanceUrl) byId('url').value = instanceUrl;
if (urlLocked) byId('url').readOnly = true;

if (allowStandalone) {
  byId('email-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('email', null);
    const mine = ++request;
    const result = await window.bulwarkWelcome.choose({ mode: 'standalone', email: byId('email').value });
    if (mine === request) answer(result, 'email');
  });
  byId('instance').addEventListener('click', () => show('org'));
  byId('org-back').addEventListener('click', () => {
    request += 1;
    byId('status').textContent = '';
    show('connection');
  });
  show(instanceUrl ? 'org' : 'connection');
} else {
  byId('connection').remove();
  byId('org-back').remove();
  show('org');
}

byId('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (byId('connect').disabled) return;
  setError('url', null);
  const mine = ++request;
  // Main asks the server first, for up to five seconds.
  byId('status').textContent = text.checking;
  byId('connect').disabled = true;
  const result = await window.bulwarkWelcome.choose({ mode: 'instance', url: byId('url').value }).finally(() => {
    byId('connect').disabled = false;
    if (mine === request) byId('status').textContent = '';
  });
  // The user went back meanwhile, or chose the other way.
  if (mine !== request || result.error === 'superseded') return;
  answer(result, 'url');
});
