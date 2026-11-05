/**
 * Electron's message box options as a Bulwark dialog window (message-box.ts), and its answer
 * back as Electron's result. No Electron here, so plain tests read it.
 *
 * The card's title is the message, its text the detail. Buttons stand as on the app's own
 * dialogs: the safe one at the start, the action at the end, so the order given (action
 * first, Cancel last, as Windows lays them out) is turned round. Enter takes `defaultId`,
 * Escape and closing the window answer `cancelId`, as Electron does. `noLink: false` (a
 * choice of several, each a name and a line below) makes rows of the other buttons.
 */

import type { DialogWindowAnswer, DialogWindowRequest } from '../shared/bridge';

export interface BoxOptions {
  message: string;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning' | string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  title?: string;
  detail?: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  noLink?: boolean;
}

export interface BoxLook {
  dark: boolean;
  background?: string;
  foreground?: string;
  language: string;
  /** For a box that names no buttons, as Electron's "OK". */
  ok: string;
}

export interface BoxPlan {
  request: Omit<DialogWindowRequest, 'id'>;
  /** The button given at `order[i]` stands at place i. */
  order: number[];
  cancelId: number;
  checked: boolean;
}

const RTL = new Set(['ar', 'fa', 'he']);

/** Electron's rule: the first button called Cancel or No, else the first button. */
export function electronCancelId(buttons: string[], cancelId: number | undefined): number {
  if (typeof cancelId === 'number' && cancelId >= 0 && cancelId < buttons.length) return cancelId;
  const found = buttons.findIndex((label) => /^(cancel|no)$/i.test(label.trim()));
  return found >= 0 ? found : 0;
}

export function planMessageBox(options: BoxOptions, look: BoxLook): BoxPlan {
  const buttons = options.buttons && options.buttons.length > 0 ? options.buttons : [look.ok];
  const cancelId = electronCancelId(buttons, options.cancelId);
  const defaultId = typeof options.defaultId === 'number' && options.defaultId >= 0 && options.defaultId < buttons.length ? options.defaultId : 0;
  const alarming = options.type === 'warning' || options.type === 'error';
  const rows = options.noLink === false && buttons.length > 1;
  // The action: the default when it isn't the safe choice, else the first that isn't.
  const action = defaultId !== cancelId ? defaultId : buttons.findIndex((_label, index) => index !== cancelId);
  const variantOf = (index: number): 'primary' | 'secondary' | 'destructive' | 'link' => {
    if (rows && index !== cancelId) return 'link';
    if (buttons.length === 1) return 'primary';
    if (index === action) return alarming ? 'destructive' : 'primary';
    return 'secondary';
  };
  // Rows in the order given; footer buttons turned round, so the safe one comes first.
  const indices = buttons.map((_label, index) => index);
  const order = rows
    ? [...indices.filter((index) => index !== cancelId), cancelId]
    : [...indices].reverse();
  const language = look.language || 'en';
  const colours: Record<string, string> = {};
  if (look.background) colours.background = look.background;
  if (look.foreground) colours.foreground = look.foreground;
  const request: Omit<DialogWindowRequest, 'id'> = {
    title: options.message,
    message: options.detail ? [{ text: options.detail }] : [],
    ...(options.type === 'warning' ? { icon: 'warning' as const } : options.type === 'error' ? { icon: 'error' as const } : {}),
    buttons: order.map((index) => ({ label: buttons[index], variant: variantOf(index) })),
    defaultIndex: order.indexOf(defaultId),
    ...(options.checkboxLabel ? { checkbox: { label: options.checkboxLabel, checked: options.checkboxChecked === true } } : {}),
    theme: { dark: look.dark, colours },
    lang: language,
    dir: RTL.has(language.split('-')[0]) ? 'rtl' : 'ltr',
  };
  return { request, order, cancelId, checked: options.checkboxChecked === true };
}

/** The dialog's answer as Electron's: the button as given, the checkbox as left. */
export function boxResult(plan: BoxPlan, answer: DialogWindowAnswer): { response: number; checkboxChecked: boolean } {
  if (!answer || !('button' in answer)) return { response: plan.cancelId, checkboxChecked: plan.checked };
  const response = plan.order[answer.button] ?? plan.cancelId;
  return { response, checkboxChecked: typeof answer.checked === 'boolean' ? answer.checked : plan.checked };
}
