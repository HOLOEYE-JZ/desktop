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
const fill = { 'privacy-title': 'privacyTitle', 'privacy-intro': 'privacyIntro', 'telemetry-label': 'telemetryLabel', 'telemetry-text': 'telemetryText', 'crash-label': 'crashLabel', 'crash-text': 'crashText', continue: 'continueLabel', back: 'back', title: 'title', intro: 'intro', 'standalone-title': 'standaloneTitle', 'standalone-text': 'standaloneText', 'instance-title': 'instanceTitle', 'instance-text': 'instanceText', 'url-label': 'urlLabel', connect: 'connect' };
for (const [id, key] of Object.entries(fill)) byId(id).textContent = text[key];
document.title = text.title;

const { allowStandalone, instanceUrl, urlLocked, askTelemetry, askCrashReports } = window.bulwarkWelcome.options;
const ERRORS = { policy: 'policy', insecure: 'insecure', email: 'email', no_jmap: 'noJmap', unreachable: 'unreachable', not_bulwark: 'notBulwark' };
/** The latest choice sent to main: an earlier answer arriving late is ignored. */
let request = 0;

if (!askTelemetry) byId('telemetry-row').remove();
if (!askCrashReports) byId('crash-row').remove();

/** The mode is chosen: the second question, if there is one. Main says. */
function next(result) {
  if (result.next !== 'privacy') return;
  byId('connection').hidden = true;
  document.title = text.privacyTitle;
  byId('privacy').classList.add('open');
  byId('continue').focus();
}

// Back to the first question. Choosing again there asks main again, which replaces the earlier choice.
byId('back').addEventListener('click', () => {
  byId('privacy').classList.remove('open');
  byId('connection').hidden = false;
  document.title = text.title;
  byId('instance').focus();
});

byId('privacy').addEventListener('submit', (event) => {
  event.preventDefault();
  void window.bulwarkWelcome.answerPrivacy({
    telemetry: byId('telemetry')?.checked === true,
    crashReports: byId('crash')?.checked === true,
  });
});

if (instanceUrl) byId('url').value = instanceUrl;
if (urlLocked) byId('url').readOnly = true;
if (!allowStandalone || instanceUrl) byId('form').classList.add('open');

// Not `hidden`: the page's own `button { display: block }` would win.
if (allowStandalone) {
  byId('standalone').addEventListener('click', () => {
    request += 1;
    byId('status').textContent = '';
    void window.bulwarkWelcome.choose({ mode: 'standalone' }).then(next);
  });
} else {
  byId('standalone').remove();
}
byId('instance').addEventListener('click', () => {
  byId('form').classList.add('open');
  byId('url').focus();
});
byId('url').addEventListener('input', () => {
  byId('error').textContent = '';
  byId('url').removeAttribute('aria-invalid');
});
byId('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (byId('connect').disabled) return;
  byId('error').textContent = '';
  const mine = ++request;
  // Main asks the server first, for up to five seconds.
  byId('status').textContent = text.checking;
  byId('connect').disabled = true;
  const result = await window.bulwarkWelcome.choose({ mode: 'instance', url: byId('url').value }).finally(() => {
    byId('connect').disabled = false;
    if (mine === request) byId('status').textContent = '';
  });
  // The standalone choice came in meanwhile, and is the one that counts.
  if (mine !== request || result.error === 'superseded') return;
  if (!result.ok) {
    byId('error').textContent = text[ERRORS[result.error] ?? 'invalid'];
    byId('url').setAttribute('aria-invalid', 'true');
    byId('url').focus();
  } else next(result);
});
