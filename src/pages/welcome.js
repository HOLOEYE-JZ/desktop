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
  },
};

const text = navigator.language.toLowerCase().startsWith('de') ? STRINGS.de : STRINGS.en;
const byId = (id) => document.getElementById(id);
const fill = { title: 'title', intro: 'intro', 'standalone-title': 'standaloneTitle', 'standalone-text': 'standaloneText', 'instance-title': 'instanceTitle', 'instance-text': 'instanceText', 'url-label': 'urlLabel', connect: 'connect' };
for (const [id, key] of Object.entries(fill)) byId(id).textContent = text[key];
document.title = text.title;

const { allowStandalone, instanceUrl, urlLocked } = window.bulwarkWelcome.options;
if (instanceUrl) byId('url').value = instanceUrl;
if (urlLocked) byId('url').readOnly = true;
if (!allowStandalone || instanceUrl) byId('form').classList.add('open');

// Not `hidden`: the page's own `button { display: block }` would win.
if (allowStandalone) {
  byId('standalone').addEventListener('click', () => {
    void window.bulwarkWelcome.choose({ mode: 'standalone' });
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
});
