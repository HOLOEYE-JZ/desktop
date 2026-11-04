import { expect, test } from '@playwright/test';
import { DIALOG_LIMITS, dialogBounds, dialogZoom, readDialogAnswer, readDialogRequest, readLook } from '../src/main/dialog-window-rules';

const base = { id: 'q1', title: 'Empty trash?', buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Empty trash', variant: 'destructive' }] };

test('a question needs an id, a title and buttons with labels', () => {
  expect(readDialogRequest(base)).not.toBeNull();
  expect(readDialogRequest({ ...base, id: '' })).toBeNull();
  expect(readDialogRequest({ ...base, id: 'x'.repeat(DIALOG_LIMITS.id + 1) })).toBeNull();
  expect(readDialogRequest({ ...base, title: '  ' })).toBeNull();
  expect(readDialogRequest({ ...base, buttons: [] })).toBeNull();
  expect(readDialogRequest({ ...base, buttons: [{ label: '' }] })).toBeNull();
  expect(readDialogRequest('Empty trash?')).toBeNull();
});

test('text stays text: one line for titles and labels, capped, no bidi tricks', () => {
  const spec = readDialogRequest({
    ...base,
    title: 'Open\nexternal\u202Elink?',
    source: 'From the plugin <b>Bulwark</b>\u2028System',
    buttons: [{ label: 'x'.repeat(100) }],
    message: [{ text: 'Line one\r\nline two\u0007' }, { text: '<img src=x onerror=alert(1)>', bold: true }],
  })!;
  expect(spec.title).toBe('Open external link?');
  expect(spec.source).toBe('From the plugin <b>Bulwark</b> System');
  expect(spec.buttons[0].label).toHaveLength(DIALOG_LIMITS.label);
  expect(spec.buttons[0].label.endsWith('…')).toBe(true);
  expect(spec.message).toEqual([{ text: 'Line one\nline two', bold: false }, { text: '<img src=x onerror=alert(1)>', bold: true }]);
  const long = readDialogRequest({ ...base, message: [{ text: 'a'.repeat(1500) }, { text: 'b'.repeat(1500) }] })!;
  expect(long.message.map((run) => run.text).join('')).toHaveLength(DIALOG_LIMITS.message);
});

test('at most four buttons; Enter takes the last one unless told otherwise', () => {
  const many = readDialogRequest({ ...base, buttons: ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label })) })!;
  expect(many.buttons).toHaveLength(4);
  expect(many.defaultIndex).toBe(3);
  expect(readDialogRequest({ ...base, defaultIndex: 0 })!.defaultIndex).toBe(0);
  expect(readDialogRequest({ ...base, defaultIndex: 7 })!.defaultIndex).toBe(1);
  expect(readDialogRequest({ ...base, buttons: [{ label: 'OK', variant: 'evil' }] })!.buttons[0].variant).toBe('primary');
});

test('the menu keeps items with a plain id and a label', () => {
  const spec = readDialogRequest({
    ...base,
    menu: { label: 'Options for X', items: [{ id: 'turn-off', label: 'Turn off X', destructive: true }, { id: 'a b', label: 'bad id' }, { id: 'ok', label: '' }] },
  })!;
  expect(spec.menu).toEqual({ label: 'Options for X', items: [{ id: 'turn-off', label: 'Turn off X', destructive: true }] });
  expect(readDialogRequest({ ...base, menu: { label: 'x', items: [] } })!.menu).toBeUndefined();
});

test('only colours, font names and sizes reach the page\'s CSS', () => {
  const look = readLook({
    dark: true,
    colours: { background: '#1c1c1c', primary: 'rgb(37, 99, 235)', foreground: 'red; background: url(https://x.invalid/)', border: 'rgba(128, 128, 128, 0.3)', ring: 'var(--x)' },
    font: '"Segoe UI", Roboto, sans-serif',
    fontSize: 18,
    radius: 0,
  });
  expect(look.colours.background).toBe('#1c1c1c');
  expect(look.colours.primary).toBe('rgb(37, 99, 235)');
  expect(look.colours.border).toBe('rgba(128, 128, 128, 0.3)');
  expect(look.colours.foreground).toBe('#fafafa');
  expect(look.colours.ring).toBe('#d4d4d4');
  expect(look.font).toBe('"Segoe UI", Roboto, sans-serif');
  expect(look.fontSize).toBe(18);
  expect(look.radius).toBe(0);
  expect(readLook({ font: 'x; } body { display: none', fontSize: 400 })).toMatchObject({ dark: false, fontSize: 16 });
  expect(readLook({ font: 'x; } body { display: none' }).font).not.toContain(';');
});

test('an answer is one this dialog has', () => {
  const spec = readDialogRequest({ ...base, menu: { label: 'Options', items: [{ id: 'turn-off', label: 'Turn off' }] } })!;
  expect(readDialogAnswer({ button: 1 }, spec)).toEqual({ button: 1 });
  expect(readDialogAnswer({ button: 2 }, spec)).toBeUndefined();
  expect(readDialogAnswer({ button: 0.5 }, spec)).toBeUndefined();
  expect(readDialogAnswer({ menu: 'turn-off' }, spec)).toEqual({ menu: 'turn-off' });
  expect(readDialogAnswer({ menu: 'uninstall' }, spec)).toBeUndefined();
  expect(readDialogAnswer(null, spec)).toBeNull();
});

test('the window is centred on its parent and kept on its screen', () => {
  const parent = { x: 100, y: 100, width: 1200, height: 800 };
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };
  expect(dialogBounds({ width: 496, height: 248 }, parent, screen)).toEqual({ x: 452, y: 376, width: 496, height: 248 });
  expect(dialogBounds({ width: 619.5, height: 309.2 }, parent, screen)).toMatchObject({ width: 620, height: 310 });
  // A parent half off the screen: the dialog stays on it.
  expect(dialogBounds({ width: 496, height: 248 }, { x: -900, y: 900, width: 1000, height: 600 }, screen)).toMatchObject({ x: 0, y: 792 });
  // Taller than the screen: as tall as the screen, the text scrolls.
  expect(dialogBounds({ width: 496, height: 3000 }, parent, screen).height).toBe(1040);
});

test('the card follows the page\'s zoom, within what a page can be zoomed to', () => {
  expect(dialogZoom(1.25)).toBe(1.25);
  expect(dialogZoom(0.1)).toBe(0.25);
  expect(dialogZoom(9)).toBe(5);
  expect(dialogZoom(Number.NaN)).toBe(1);
});
