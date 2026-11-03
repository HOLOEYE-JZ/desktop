const STRINGS = {
  en: {
    title: 'Welcome to Bulwark',
    intro: 'How do you want to use it?',
    standaloneTitle: 'With any mail server',
    standaloneText: 'Sign in directly to a JMAP mail server, such as Stalwart.',
    instanceTitle: 'With a Bulwark server',
    instanceText: 'Your organisation runs Bulwark. Open it here as an app.',
    urlLabel: 'Address of your Bulwark server',
    connect: 'Connect',
    invalid: 'Enter the full https address of your server.',
    policy: "Your organisation doesn't allow this server.",
    privacyTitle: 'Help improve Bulwark?',
    privacyIntro: "Both are off unless you tick them. You can change this later in Settings.",
    telemetryLabel: 'Send usage info',
    telemetryText: 'Once a day: the app version, your operating system and how the app connects. With your own mail server, also which features are on and a rough number of accounts. Never mail, addresses or server names.',
    crashLabel: 'Send crash reports',
    crashText: "Errors in the app go out with file names from the app's own code and short, cleaned-up messages. If the app itself crashes, a crash file stays on this computer. It's a copy of part of the app's memory, so it can contain parts of open mail. A crash file only leaves when you send it.",
    continueLabel: 'Continue',
  },
  de: {
    title: 'Willkommen bei Bulwark',
    intro: 'Wie möchten Sie es verwenden?',
    standaloneTitle: 'Mit einem beliebigen Mailserver',
    standaloneText: 'Melden Sie sich direkt bei einem JMAP-Mailserver an, etwa bei Stalwart.',
    instanceTitle: 'Mit einem Bulwark-Server',
    instanceText: 'Ihre Organisation betreibt Bulwark. Öffnen Sie es hier als App.',
    urlLabel: 'Adresse Ihres Bulwark-Servers',
    connect: 'Verbinden',
    invalid: 'Geben Sie die vollständige https-Adresse Ihres Servers ein.',
    policy: 'Ihre Organisation erlaubt diesen Server nicht.',
    privacyTitle: 'Möchten Sie helfen, Bulwark zu verbessern?',
    privacyIntro: 'Beides bleibt aus, wenn Sie nichts ankreuzen. Sie können das später in den Einstellungen ändern.',
    telemetryLabel: 'Nutzungsdaten senden',
    telemetryText: 'Einmal am Tag: die App-Version, Ihr Betriebssystem und die Art der Verbindung. Bei einem eigenen Mailserver auch, welche Funktionen aktiv sind, und eine ungefähre Zahl der Konten. Niemals E-Mails, Adressen oder Servernamen.',
    crashLabel: 'Absturzberichte senden',
    crashText: 'Fehler in der App werden mit Dateinamen aus dem eigenen Code der App und kurzen, bereinigten Meldungen gesendet. Stürzt die App selbst ab, bleibt eine Absturzdatei auf diesem Computer. Sie ist eine Kopie eines Teils des Arbeitsspeichers der App und kann daher Teile geöffneter E-Mails enthalten. Eine Absturzdatei verlässt den Computer nur, wenn Sie sie senden.',
    continueLabel: 'Weiter',
  },
};

const text = navigator.language.toLowerCase().startsWith('de') ? STRINGS.de : STRINGS.en;
const byId = (id) => document.getElementById(id);
const fill = { 'privacy-title': 'privacyTitle', 'privacy-intro': 'privacyIntro', 'telemetry-label': 'telemetryLabel', 'telemetry-text': 'telemetryText', 'crash-label': 'crashLabel', 'crash-text': 'crashText', continue: 'continueLabel', title: 'title', intro: 'intro', 'standalone-title': 'standaloneTitle', 'standalone-text': 'standaloneText', 'instance-title': 'instanceTitle', 'instance-text': 'instanceText', 'url-label': 'urlLabel', connect: 'connect' };
for (const [id, key] of Object.entries(fill)) byId(id).textContent = text[key];
document.title = text.title;

const { allowStandalone, instanceUrl, urlLocked, askTelemetry, askCrashReports } = window.bulwarkWelcome.options;

/** The mode is chosen: the second question, if there is one. Main says. */
function next(result) {
  if (result.next !== 'privacy') return;
  byId('connection').remove();
  document.title = text.privacyTitle;
  if (!askTelemetry) byId('telemetry-row').remove();
  if (!askCrashReports) byId('crash-row').remove();
  byId('privacy').classList.add('open');
  byId('continue').focus();
}

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
    void window.bulwarkWelcome.choose({ mode: 'standalone' }).then(next);
  });
} else {
  byId('standalone').remove();
}
byId('instance').addEventListener('click', () => {
  byId('form').classList.add('open');
  byId('url').focus();
});
byId('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('error').textContent = '';
  const result = await window.bulwarkWelcome.choose({ mode: 'instance', url: byId('url').value });
  if (!result.ok) byId('error').textContent = result.error === 'policy' ? text.policy : text.invalid;
  else next(result);
});
