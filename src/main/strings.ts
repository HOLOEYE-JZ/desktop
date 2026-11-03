/**
 * Shell strings, en and de. English is the fallback. Everything the webmail
 * shows is translated in the webmail; this is only what appears before it runs
 * or in native dialogs.
 */

import { app } from 'electron';

const en = {
  allow: 'Allow',
  cancel: 'Cancel',
  install: 'Install',
  serverHttpTitle: 'Connect without encryption?',
  serverHttpDetail: (host: string) =>
    `${host} uses plain http. Your password and your mail travel over the network unencrypted, and anyone on that network can read them. Only allow this for a server you run yourself on a network you trust.`,
  serverLanTitle: 'Connect to a server on your local network?',
  serverLanDetail: (host: string) =>
    `${host} is on a private network. Bulwark only connects to private addresses that you allow. Allow this if you know this server.`,
  pluginInstallTitle: (slug: string) => `Install the plugin "${slug}"?`,
  pluginInstallDetail: 'It comes from the plugin directory and its signature is checked. Plugins can read and change what they ask permission for.',
  errorSecretsTitle: "Bulwark can't read its keys",
  errorSecretsBody:
    'The key that protects your sign-ins is encrypted with your system account, and this system can\'t decrypt it right now. Nothing was changed or deleted, so your accounts and offline mail are still there. Check that you are signed in to the same system account, and that the system key store is unlocked, then start Bulwark again.',
  errorServerTitle: "Bulwark couldn't start",
  errorServerBody: 'The built-in mail service did not start. Restart Bulwark. If this keeps happening, reinstall it. Your accounts and mail are not affected.',
  errorCertificateTitle: "Bulwark can't reach its own mail service safely",
  errorCertificateBody:
    'Something on this computer is changing the encrypted connection between Bulwark and its built-in mail service, usually a security program that inspects encrypted traffic. Add Bulwark as an exception in that program, then start Bulwark again. Your accounts and mail are not affected.',
  signInDone: 'You are signed in. You can close this window and go back to Bulwark.',
  signInFailed: 'Signing in did not work. Go back to Bulwark and try again.',
  menuFile: 'File',
  menuEdit: 'Edit',
  menuWindow: 'Window',
  menuSwitchMode: 'Change Connection…',
};

const de: typeof en = {
  allow: 'Zulassen',
  cancel: 'Abbrechen',
  install: 'Installieren',
  serverHttpTitle: 'Ohne Verschlüsselung verbinden?',
  serverHttpDetail: (host) =>
    `${host} verwendet unverschlüsseltes http. Ihr Passwort und Ihre E-Mails gehen unverschlüsselt über das Netzwerk, und jeder in diesem Netzwerk kann sie lesen. Lassen Sie das nur für einen eigenen Server in einem Netzwerk zu, dem Sie vertrauen.`,
  serverLanTitle: 'Mit einem Server im lokalen Netzwerk verbinden?',
  serverLanDetail: (host) =>
    `${host} liegt in einem privaten Netzwerk. Bulwark verbindet sich nur mit privaten Adressen, die Sie zulassen. Lassen Sie das zu, wenn Sie diesen Server kennen.`,
  pluginInstallTitle: (slug) => `Das Plugin „${slug}“ installieren?`,
  pluginInstallDetail: 'Es stammt aus dem Plugin-Verzeichnis, seine Signatur wird geprüft. Plugins können lesen und ändern, wofür sie um Erlaubnis bitten.',
  errorSecretsTitle: 'Bulwark kann seine Schlüssel nicht lesen',
  errorSecretsBody:
    'Der Schlüssel, der Ihre Anmeldungen schützt, ist mit Ihrem Systemkonto verschlüsselt, und das System kann ihn gerade nicht entschlüsseln. Es wurde nichts geändert oder gelöscht, Ihre Konten und Offline-E-Mails sind also noch da. Prüfen Sie, ob Sie mit demselben Systemkonto angemeldet sind und der Schlüsselspeicher des Systems entsperrt ist, und starten Sie Bulwark dann neu.',
  errorServerTitle: 'Bulwark konnte nicht starten',
  errorServerBody: 'Der eingebaute Mail-Dienst ist nicht gestartet. Starten Sie Bulwark neu. Passiert das weiterhin, installieren Sie es neu. Ihre Konten und E-Mails sind davon nicht betroffen.',
  errorCertificateTitle: 'Bulwark erreicht seinen eigenen Mail-Dienst nicht sicher',
  errorCertificateBody:
    'Etwas auf diesem Computer verändert die verschlüsselte Verbindung zwischen Bulwark und seinem eingebauten Mail-Dienst, meist ein Sicherheitsprogramm, das verschlüsselten Datenverkehr prüft. Nehmen Sie Bulwark in diesem Programm als Ausnahme auf und starten Sie Bulwark dann neu. Ihre Konten und E-Mails sind davon nicht betroffen.',
  signInDone: 'Sie sind angemeldet. Sie können dieses Fenster schließen und zu Bulwark zurückkehren.',
  signInFailed: 'Die Anmeldung hat nicht geklappt. Gehen Sie zurück zu Bulwark und versuchen Sie es noch einmal.',
  menuFile: 'Datei',
  menuEdit: 'Bearbeiten',
  menuWindow: 'Fenster',
  menuSwitchMode: 'Verbindung ändern…',
};

export function strings(): typeof en {
  return app.getLocale().toLowerCase().startsWith('de') ? de : en;
}
