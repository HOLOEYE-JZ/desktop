import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { boxResult, electronCancelId, planMessageBox } from '../src/main/message-box-rules';
import { readDialogAnswer, readDialogRequest } from '../src/main/dialog-window-rules';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOOK = { dark: true, background: '#0a0a0a', foreground: '#fafafa', language: 'de', ok: 'OK' };

test('no native message box is left in the shell, except where no window of the app\'s can show', () => {
  // The shell's questions are Bulwark windows (src/main/message-box.ts). Native only: the
  // fallback before Electron is ready, the sandbox refused (the window needs it), a failed start.
  const found: Record<string, string[]> = {};
  for (const file of readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[]) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(path.join(ROOT, 'src', file), 'utf8');
    const calls = [...text.matchAll(/dialog\.(showMessageBox|showMessageBoxSync|showErrorBox)\(/g)].map((m) => m[1]);
    if (calls.length > 0) found[file.split(path.sep).join('/')] = calls;
  }
  expect(found).toEqual({
    'main/index.ts': ['showMessageBoxSync', 'showErrorBox'],
    'main/message-box.ts': ['showMessageBox', 'showMessageBox'],
  });
});

test('a question reads as the app\'s: the action at the end, the safe choice first, in the app\'s look and language', () => {
  const plan = planMessageBox({
    type: 'warning',
    title: 'Bulwark',
    message: 'Remove local data and sign out?',
    detail: 'Mail kept on this device is deleted.',
    buttons: ['Remove and sign out', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }, LOOK);
  expect(plan.request).toMatchObject({
    title: 'Remove local data and sign out?',
    message: [{ text: 'Mail kept on this device is deleted.' }],
    icon: 'warning',
    buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Remove and sign out', variant: 'destructive' }],
    // Enter stays on Cancel, as it was.
    defaultIndex: 0,
    theme: { dark: true, colours: { background: '#0a0a0a', foreground: '#fafafa' } },
    lang: 'de',
    dir: 'ltr',
  });
  // The answers come back as the buttons were given.
  expect(boxResult(plan, { button: 1 })).toEqual({ response: 0, checkboxChecked: false });
  expect(boxResult(plan, { button: 0 })).toEqual({ response: 1, checkboxChecked: false });
  // Escape or closing the window: cancelId, as Electron.
  expect(boxResult(plan, null)).toEqual({ response: 1, checkboxChecked: false });
  // The request is one the dialog window takes.
  expect(readDialogRequest({ ...plan.request, id: 'x' }, { shell: true })).not.toBeNull();
});

test('three buttons keep their meaning; a notice with none gets OK; Electron\'s cancel rule holds', () => {
  const plan = planMessageBox({ type: 'question', message: 'Restart now?', buttons: ['Restart', 'Later', 'Never'], defaultId: 0, cancelId: 1 }, LOOK);
  expect(plan.request.buttons.map((b) => b.label)).toEqual(['Never', 'Later', 'Restart']);
  expect(plan.request.buttons[2].variant).toBe('primary');
  expect(plan.request.defaultIndex).toBe(2);
  expect(boxResult(plan, { button: 0 }).response).toBe(2);

  const notice = planMessageBox({ type: 'info', message: 'Your sign-ins were lost.' }, LOOK);
  expect(notice.request.buttons).toEqual([{ label: 'OK', variant: 'primary' }]);
  expect(boxResult(notice, null).response).toBe(0);

  expect(electronCancelId(['Yes', 'No'], undefined)).toBe(1);
  expect(electronCancelId(['Allow', 'Deny'], undefined)).toBe(0);
  expect(planMessageBox({ message: 'x', buttons: ['a'] }, { ...LOOK, language: 'he' }).request.dir).toBe('rtl');
});

test('a choice of certificates: a row each, None in the footer, the checkbox comes back', () => {
  const plan = planMessageBox({
    type: 'question',
    message: 'mail.example.org asks for a certificate',
    buttons: ['Alice Example\nIssued by Test CA, expires 1 Jan 2030', 'Alice Old\nIssued by Test CA, expires 1 Jan 2027', 'More…', 'Send none'],
    defaultId: 3,
    cancelId: 3,
    noLink: false,
    checkboxLabel: 'Remember for mail.example.org',
    checkboxChecked: false,
  }, LOOK);
  expect(plan.request.buttons.map((b) => b.variant)).toEqual(['link', 'link', 'link', 'secondary']);
  expect(plan.request.checkbox).toEqual({ label: 'Remember for mail.example.org', checked: false });
  const spec = readDialogRequest({ ...plan.request, id: 'c' }, { shell: true })!;
  // A row keeps its second line; a page's request gets neither rows nor a checkbox.
  expect(spec.buttons[0]).toEqual({ label: 'Alice Example\nIssued by Test CA, expires 1 Jan 2030', variant: 'link' });
  const fromPage = readDialogRequest({ ...plan.request, id: 'c' })!;
  expect(fromPage.buttons.some((b) => b.variant === 'link')).toBe(false);
  expect(fromPage.checkbox).toBeUndefined();
  expect(readDialogAnswer({ button: 1, checked: true }, spec)).toEqual({ button: 1, checked: true });
  expect(boxResult(plan, { button: 1, checked: true })).toEqual({ response: 1, checkboxChecked: true });
  expect(boxResult(plan, null)).toEqual({ response: 3, checkboxChecked: false });
});
