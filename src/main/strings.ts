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
  pluginInstallTitle: (name: string) => `Install the plugin "${name}"?`,
  pluginPublisher: (publisher: string, verified: boolean) => `Published by ${publisher}${verified ? ' (verified)' : ''}. Its signature is checked.`,
  pluginNoPublisher: 'The directory names no publisher. Its signature is checked.',
  pluginPermissions: 'It asks to:',
  pluginNoPermissions: 'It asks for no special permissions.',
  pluginPrivileged: 'Warning: this plugin runs with full access to the app. It can read all your mail and accounts, and everything you do here. Only install it if you trust the publisher.',
  serverSecondOriginTitle: (server: string) => `${server} also uses another server. Allow it?`,
  serverSecondOriginDetail: (host: string) => `Your mail server says your attachments or messages are on ${host}. Bulwark sends your sign-in there if you allow this.`,
  leaveTitle: 'Leave with unsaved changes?',
  leaveDetail: 'What you changed on this page is not saved yet.',
  leave: 'Leave',
  stay: 'Stay',
  errorSecretMissingTitle: "Bulwark's key file is missing",
  errorSecretMissingBody: (dir: string) => `This profile was set up before, but the key that protects your sign-ins is gone from ${dir}. Bulwark won't make a new one, because that would sign out every account and remove their offline mail. Restore the file from a backup and start Bulwark again. To start over instead, delete the folder above the keys folder.`,
  errorSecretsTitle: "Bulwark can't read its keys",
  errorSecretsBody:
    'The key that protects your sign-ins is encrypted with your system account, and this system can\'t decrypt it right now. Nothing was changed or deleted, so your accounts and offline mail are still there. Check that you are signed in to the same system account, and that the system key store is unlocked, then start Bulwark again.',
  errorServerTitle: "Bulwark couldn't start",
  errorServerBody: 'The built-in mail service did not start. Restart Bulwark. If this keeps happening, reinstall it. Your accounts and mail are not affected.',
  errorCertificateTitle: "Bulwark can't reach its own mail service safely",
  errorCertificateBody:
    'Something on this computer is changing the encrypted connection between Bulwark and its built-in mail service, usually a security program that inspects encrypted traffic. Add Bulwark as an exception in that program, then start Bulwark again. Your accounts and mail are not affected.',
  policyErrorTitle: "Your organisation's settings for Bulwark can't be used",
  policyErrorBody: (policy: string, reason: string, raw?: string) =>
    `The policy ${policy}${raw ? ` is set to "${raw}", which` : ''} can't be used: ${reason} Bulwark stays closed until your administrator corrects it. Nothing on this computer was changed.`,
  policyReasons: {
    insecure: 'it uses plain http, and the policy AllowInsecureInstance does not allow that.',
    scheme: 'the address has to start with https://.',
    invalid_url: 'it is not a valid address.',
    empty: 'it is empty.',
    too_long: 'it is too long.',
    not_text: 'it is not text.',
    not_root_owned: 'the file does not belong to root.',
    writable_by_others: 'others than root can change the file.',
    dir_unsafe: 'others than root can change its folder.',
    not_a_file: 'it is not a plain file.',
    too_large: 'the file is too large.',
    not_json: 'the file is not valid JSON.',
    unreadable: 'the file cannot be read.',
    reg_failed: 'the registry could not be read.',
    reg_blocked: 'the registry could not be read.',
    watcher_failed: 'the registry could not be read.',
    reg_mismatch: 'the registry could not be read reliably.',
    plist_unsafe: 'others than root can change the managed settings file.',
    plist_unreadable: 'the managed settings file cannot be read.',
    other: 'the value is not valid.',
  } as Record<string, string>,
  policyChangedTitle: 'Your organisation changed the settings for Bulwark',
  policyChangedDetail: 'Bulwark has to restart for this to take effect. What you are writing is saved first.',
  policyRestart: 'Restart Now',
  policyLater: 'Later',
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
  pluginInstallTitle: (name) => `Das Plugin „${name}“ installieren?`,
  pluginPublisher: (publisher, verified) => `Herausgeber: ${publisher}${verified ? ' (verifiziert)' : ''}. Seine Signatur wird geprüft.`,
  pluginNoPublisher: 'Das Verzeichnis nennt keinen Herausgeber. Die Signatur wird geprüft.',
  pluginPermissions: 'Es möchte:',
  pluginNoPermissions: 'Es fragt nach keinen besonderen Berechtigungen.',
  pluginPrivileged: 'Warnung: Dieses Plugin läuft mit vollem Zugriff auf die App. Es kann alle Ihre E-Mails und Konten lesen und alles, was Sie hier tun. Installieren Sie es nur, wenn Sie dem Herausgeber vertrauen.',
  serverSecondOriginTitle: (server) => `${server} verwendet noch einen weiteren Server. Zulassen?`,
  serverSecondOriginDetail: (host) => `Ihr Mailserver gibt an, dass Ihre Anhänge oder Nachrichten auf ${host} liegen. Wenn Sie das zulassen, sendet Bulwark Ihre Anmeldung auch dorthin.`,
  leaveTitle: 'Mit ungespeicherten Änderungen verlassen?',
  leaveDetail: 'Was Sie auf dieser Seite geändert haben, ist noch nicht gespeichert.',
  leave: 'Verlassen',
  stay: 'Bleiben',
  errorSecretMissingTitle: 'Die Schlüsseldatei von Bulwark fehlt',
  errorSecretMissingBody: (dir) => `Dieses Profil wurde schon eingerichtet, aber der Schlüssel, der Ihre Anmeldungen schützt, fehlt in ${dir}. Bulwark erstellt keinen neuen, denn das würde alle Konten abmelden und ihre Offline-E-Mails entfernen. Stellen Sie die Datei aus einer Sicherung wieder her und starten Sie Bulwark neu. Um neu zu beginnen, löschen Sie den Ordner über dem Schlüsselordner.`,
  errorSecretsTitle: 'Bulwark kann seine Schlüssel nicht lesen',
  errorSecretsBody:
    'Der Schlüssel, der Ihre Anmeldungen schützt, ist mit Ihrem Systemkonto verschlüsselt, und das System kann ihn gerade nicht entschlüsseln. Es wurde nichts geändert oder gelöscht, Ihre Konten und Offline-E-Mails sind also noch da. Prüfen Sie, ob Sie mit demselben Systemkonto angemeldet sind und der Schlüsselspeicher des Systems entsperrt ist, und starten Sie Bulwark dann neu.',
  errorServerTitle: 'Bulwark konnte nicht starten',
  errorServerBody: 'Der eingebaute Mail-Dienst ist nicht gestartet. Starten Sie Bulwark neu. Passiert das weiterhin, installieren Sie es neu. Ihre Konten und E-Mails sind davon nicht betroffen.',
  errorCertificateTitle: 'Bulwark erreicht seinen eigenen Mail-Dienst nicht sicher',
  errorCertificateBody:
    'Etwas auf diesem Computer verändert die verschlüsselte Verbindung zwischen Bulwark und seinem eingebauten Mail-Dienst, meist ein Sicherheitsprogramm, das verschlüsselten Datenverkehr prüft. Nehmen Sie Bulwark in diesem Programm als Ausnahme auf und starten Sie Bulwark dann neu. Ihre Konten und E-Mails sind davon nicht betroffen.',
  policyErrorTitle: 'Die Einstellungen Ihrer Organisation für Bulwark können nicht verwendet werden',
  policyErrorBody: (policy, reason, raw) =>
    `Die Richtlinie ${policy}${raw ? ` ist auf „${raw}“ gesetzt und` : ''} kann nicht verwendet werden: ${reason} Bulwark bleibt geschlossen, bis Ihr Administrator das korrigiert. Auf diesem Computer wurde nichts geändert.`,
  policyReasons: {
    insecure: 'Sie verwendet unverschlüsseltes http, und die Richtlinie AllowInsecureInstance erlaubt das nicht.',
    scheme: 'Die Adresse muss mit https:// beginnen.',
    invalid_url: 'Das ist keine gültige Adresse.',
    empty: 'Sie ist leer.',
    too_long: 'Sie ist zu lang.',
    not_text: 'Sie ist kein Text.',
    not_root_owned: 'Die Datei gehört nicht root.',
    writable_by_others: 'Nicht nur root kann die Datei ändern.',
    dir_unsafe: 'Nicht nur root kann ihren Ordner ändern.',
    not_a_file: 'Das ist keine normale Datei.',
    too_large: 'Die Datei ist zu groß.',
    not_json: 'Die Datei enthält kein gültiges JSON.',
    unreadable: 'Die Datei kann nicht gelesen werden.',
    reg_failed: 'Die Registrierung konnte nicht gelesen werden.',
    reg_blocked: 'Die Registrierung konnte nicht gelesen werden.',
    watcher_failed: 'Die Registrierung konnte nicht gelesen werden.',
    reg_mismatch: 'Die Registrierung konnte nicht zuverlässig gelesen werden.',
    plist_unsafe: 'Nicht nur root kann die Datei mit den verwalteten Einstellungen ändern.',
    plist_unreadable: 'Die Datei mit den verwalteten Einstellungen kann nicht gelesen werden.',
    other: 'Der Wert ist nicht gültig.',
  },
  policyChangedTitle: 'Ihre Organisation hat die Einstellungen für Bulwark geändert',
  policyChangedDetail: 'Bulwark muss neu starten, damit das wirksam wird. Was Sie gerade schreiben, wird vorher gespeichert.',
  policyRestart: 'Jetzt neu starten',
  policyLater: 'Später',
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
