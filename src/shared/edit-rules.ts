/**
 * Which attachments may be opened in another program from "Edit". Shared by main, which
 * enforces it, and the preload, so the page can hide the menu item without a second list.
 * No node modules: the preload is sandboxed.
 *
 * Edit hands a file from a stranger to whatever the OS runs for its extension. Everything
 * here runs code, installs something, mounts a disk, or points somewhere else when it's
 * opened, on one of the three platforms. A list of allowed types would be stricter, but
 * then nobody could edit a drawing or a plan in the program made for it. Outlook's blocked
 * list and Chromium's dangerous-download list are where this one comes from. Macro formats
 * are here because they run code once someone clicks past one warning, and web pages
 * because the default program for them is a browser that runs their script.
 */

const BLOCKED_EXTENSIONS = new Set([
  // Windows programs and installers
  'exe', 'com', 'scr', 'pif', 'cpl', 'dll', 'ocx', 'sys', 'drv', 'efi', 'msi', 'msp', 'mst', 'msu', 'msix', 'msixbundle',
  'appx', 'appxbundle', 'appinstaller', 'application', 'gadget', 'xbap', 'vsix', 'vsto', 'wsb', 'cab', 'inf', 'ins', 'isp', 'reg', 'rgs',
  // Windows scripts
  'bat', 'cmd', 'js', 'jse', 'vb', 'vbe', 'vbs', 'vbscript', 'ws', 'wsc', 'wsf', 'wsh', 'sct', 'hta', 'htc', 'ps1', 'ps1xml', 'ps2', 'ps2xml',
  'psc1', 'psc2', 'psd1', 'psm1', 'pssc', 'cdxml', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'shb', 'shs', 'job', 'tmp',
  // Windows links and things that point elsewhere
  'lnk', 'url', 'scf', 'library-ms', 'search-ms', 'searchconnector-ms', 'appref-ms', 'website', 'settingcontent-ms', 'webpnp', 'rdp', 'mcf',
  'cnt', 'grp', 'hlp', 'hpj', 'chm', 'its', 'theme', 'themepack', 'deskthemepack', 'diagcab', 'diagcfg', 'diagpkg', 'printerexport',
  'cer', 'crt', 'der', 'p7b', 'p7c', 'pfx', 'p12', 'sst', 'stl',
  // Disk images, which keep what's inside them out of the OS's checks
  'iso', 'img', 'vhd', 'vhdx', 'wim', 'dmg', 'sparsebundle', 'sparseimage',
  // Office formats that hold code
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xla', 'xlm', 'xll', 'xlsb', 'slk', 'iqy', 'pptm', 'potm', 'ppsm', 'ppam', 'ppa', 'sldm', 'wll', 'wbk',
  'mdb', 'mde', 'mda', 'mdt', 'mdw', 'mdz', 'accda', 'accdb', 'accde', 'accdr', 'accdt', 'ade', 'adp', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas',
  'mat', 'mau', 'mav', 'maw', 'one', 'onepkg', 'vsmacros', 'vsw', 'vss', 'vst',
  // Web pages and what a browser would run
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'shtm', 'mht', 'mhtml', 'svg', 'svgz', 'xsl', 'xslt', 'htt', 'hti', 'asp', 'aspx', 'php', 'jsp', 'swf',
  // Other languages' programs
  'jar', 'jnlp', 'class', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'pl', 'pm', 'rb', 'lua', 'tcl', 'bas', 'fxp', 'prg', 'nsh', 'ksh', 'csh', 'bash', 'sh', 'zsh', 'fish', 'r',
  // macOS
  'app', 'action', 'command', 'tool', 'terminal', 'workflow', 'scpt', 'scptd', 'applescript', 'osax', 'pkg', 'mpkg', 'prefpane', 'webloc', 'inetloc', 'fileloc', 'dylib', 'kext', 'mobileconfig',
  // Linux
  'desktop', 'run', 'bin', 'elf', 'out', 'so', 'ko', 'appimage', 'deb', 'rpm', 'snap', 'flatpak', 'flatpakref', 'flatpakrepo',
]);

/** An unchanged copy: a program may still hold it, and a start can't tell. */
export const EDIT_UNCHANGED_KEEP_MS = 24 * 60 * 60_000;
/** A changed copy nobody looked at. */
export const EDIT_CHANGED_KEEP_MS = 30 * 24 * 60 * 60_000;

/** A long path is what Office refuses first: it stops at about 218 characters. */
const MAX_NAME_LENGTH = 100;
const MAX_EXTENSION_LENGTH = 16;

/**
 * The name the file gets on disk, or null when this file stays out of Edit. Control and
 * direction characters go first, and a trailing dot or space, because Windows drops those
 * when it looks at a name: `invoice.exe.` and `invoice.exe ` both run.
 */
export function editFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const dot = base.lastIndexOf('.');
  // No extension means no program the OS could pick, and on a Mac or Linux it can be a script.
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  if (!extension || extension.length > MAX_EXTENSION_LENGTH || BLOCKED_EXTENSIONS.has(extension)) return null;
  const stem = base.slice(0, dot).replace(/[\s.]+$/g, '').slice(0, MAX_NAME_LENGTH - extension.length - 1).replace(/[\s.]+$/g, '');
  if (!stem) return null;
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) ? `_${stem}` : stem;
  return `${safeStem}.${base.slice(dot + 1)}`;
}
