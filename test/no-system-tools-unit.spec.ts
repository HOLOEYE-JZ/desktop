// The app starts none of Windows' own tools. Endpoint protection (lockdown and "LOLBin" rules)
// blocks or flags an app that starts PowerShell, cmd, reg.exe, icacls and the like, and one
// such block stopped the installed app from starting. What main needed them for is in the
// native helper now (native/src/system_windows.rs). This reads the source: every process main
// starts is listed here, and none of them is a Windows tool.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCES = ['src/main', 'src/server', 'src/preload'];

/** What main may start, by the program's first argument. None of these is on Windows. */
const ALLOWED_PROGRAMS = new Set([
  // Itself, for the key check before Chromium starts (index.ts).
  'process.execPath',
  // macOS: files to the pasteboard, recent files, managed preferences.
  "'/usr/bin/osascript'",
  "'/usr/bin/mdfind'",
  "'/usr/bin/plutil'",
  // Linux: notification banners, the default mail app, a running Thunderbird.
  "'/usr/bin/gsettings'",
  "'xdg-mime'",
  "'/usr/bin/pgrep'",
]);

/** Windows' tools that endpoint protection watches for, and the ways main used to reach them. */
const WINDOWS_TOOLS = /\b(powershell|pwsh|cmd|reg|regedit|icacls|cacls|takeown|whoami|subst|attrib|schtasks|rundll32|regsvr32|wmic|taskkill|tasklist|certutil|mshta|cscript|wscript|bitsadmin|netsh|sc|bcdedit|vssadmin|wevtutil|msiexec|forfiles|robocopy|xcopy|findstr|where|chcp)\.exe\b|\bsystemExe\s*\(|\bComSpec\b|GLOBALROOT\\+SystemRoot/i;

function sources(): { file: string; code: string }[] {
  const found: { file: string; code: string }[] = [];
  for (const folder of SOURCES) {
    const dir = path.join(ROOT, folder);
    for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|cts|mts|js|cjs|mjs)$/.test(name)) continue;
      found.push({ file: path.join(folder, name), code: withoutComments(readFileSync(path.join(dir, name), 'utf8')) });
    }
  }
  return found;
}

/** Comments out, so a note about what used to run doesn't count. Strings stay. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Each call that starts a program, with its first argument as written. */
function launches(code: string): { call: string; program: string }[] {
  const found: { call: string; program: string }[] = [];
  for (const match of code.matchAll(/(?<![.\w$])(execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\s*\(/g)) {
    found.push({ call: match[1], program: firstArgument(code, match.index + match[0].length) });
  }
  return found;
}

/** From just after a call's `(` to the first comma or `)` outside brackets and strings. */
function firstArgument(code: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let at = from; at < code.length; at += 1) {
    const char = code[at];
    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char) && depth > 0) depth -= 1;
    else if (depth === 0 && (char === ',' || char === ')')) return code.slice(from, at).trim();
  }
  return code.slice(from).trim();
}

test('main starts no program but the ones listed, and none of them is a Windows tool', () => {
  const files = sources();
  expect(files.length).toBeGreaterThan(50);
  const unexpected: string[] = [];
  for (const { file, code } of files) {
    for (const launch of launches(code)) {
      if (!ALLOWED_PROGRAMS.has(launch.program)) unexpected.push(`${file}: ${launch.call}(${launch.program}, ...)`);
    }
  }
  expect(unexpected).toEqual([]);
});

test('no source names a Windows tool, PowerShell or the way to a system folder', () => {
  const named = sources()
    .map(({ file, code }) => ({ file, match: WINDOWS_TOOLS.exec(code)?.[0] }))
    .filter((found) => found.match)
    .map((found) => `${found.file}: ${found.match}`);
  expect(named).toEqual([]);
});

test('child_process comes in by name only, so every call it makes is seen above', () => {
  const loose: string[] = [];
  for (const { file, code } of sources()) {
    if (/require\(\s*['"](node:)?child_process['"]\s*\)/.test(code)) loose.push(`${file}: require`);
    if (/import\s+(\*\s+as\s+\w+|\w+)\s*(,\s*\{[^}]*\})?\s+from\s+['"](node:)?child_process['"]/.test(code)) loose.push(`${file}: namespace or default import`);
    if (/import\(\s*['"](node:)?child_process['"]\s*\)/.test(code)) loose.push(`${file}: dynamic import`);
    for (const named of code.matchAll(/import\s*\{([^}]*)\}\s*from\s+['"](node:)?child_process['"]/g)) {
      for (const part of named[1].split(',').map((name) => name.trim()).filter(Boolean)) {
        if (/\bas\b/.test(part) || !/^(type\s+)?(execFileSync|execFile|execSync|exec|spawnSync|spawn|fork|ChildProcess|SpawnOptions)$/.test(part)) loose.push(`${file}: ${part}`);
      }
    }
  }
  expect(loose).toEqual([]);
});

test('nothing hands child_process on to call it elsewhere (promisify, a variable)', () => {
  const handed: string[] = [];
  for (const { file, code } of sources()) {
    const body = code.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
    for (const match of body.matchAll(/(?<![.\w$'"`])(execFileSync|execFile|execSync|spawnSync|spawn)\b(?!\s*\()/g)) handed.push(`${file}: ${match[1]}`);
  }
  expect(handed).toEqual([]);
});

test('the check sees what it is there for', () => {
  // The two launches main had, the Focus Assist check and a registry write, as they were written.
  const before = "execFile(\n      systemExe('powershell.exe'),\n      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],";
  expect(launches(before)).toEqual([{ call: 'execFile', program: "systemExe('powershell.exe')" }]);
  expect(WINDOWS_TOOLS.test(before)).toBe(true);
  expect(launches("spawn(cmd, regCommandLine(file, args))")).toEqual([{ call: 'spawn', program: 'cmd' }]);
  expect(WINDOWS_TOOLS.test("const file = `${root}\\\\System32\\\\reg.exe`;")).toBe(true);
  // The private folder's whoami and icacls went through a promisified execFile.
  expect('const run = promisify(execFile);'.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')).toMatch(/(?<![.\w$'"`])(execFile)\b(?!\s*\()/);
  // A regular expression's exec and Electron's utilityProcess.fork are no launches.
  expect(launches("/x/.exec(text); utilityProcess.fork(script, [])")).toEqual([]);
  // A registry key that happens to name Explorer is no launch either.
  expect(WINDOWS_TOOLS.test("'Software\\\\Classes\\\\Applications\\\\Explorer.exe\\\\Drives'")).toBe(false);
});
