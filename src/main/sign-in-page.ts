/**
 * The pages the browser shows during "Sign in with your browser", served by the loopback
 * listener in browser-sign-in.ts: the result of a redirect, and the password form for a
 * server without OAuth.
 *
 * They look like the webmail's sign-in card in its standard theme, light or dark as the
 * browser is, with the app icon's mark in the brand colour. They speak the browser's
 * language (Accept-Language), in the app's 30 languages, from sign-in-strings.json.
 *
 * Nothing loads from anywhere: the style and the one script are inline, each allowed by
 * its hash. No Electron here, so a plain Node test renders them.
 */

import { createHash } from 'node:crypto';
import STRINGS from '../pages/sign-in-strings.json' with { type: 'json' };

export type SignInWords = (typeof STRINGS)['en'];
export type SignInLanguage = keyof typeof STRINGS;

export const SIGN_IN_LANGUAGES = Object.keys(STRINGS) as SignInLanguage[];
const RTL = new Set(['ar', 'fa', 'he']);
/** More than any browser sends. What's past it isn't read. */
const MAX_ACCEPT_LANGUAGE = 1024;

/** How a redirect, or a password sign-in, ended. */
export type SignInOutcome = 'done' | 'declined' | 'failed' | 'used' | 'expired';

function known(tag: string): SignInLanguage | null {
  const lower = tag.trim().toLowerCase();
  if (!lower || lower === '*') return null;
  const [primary, ...rest] = lower.split(/[-_]/);
  if (primary === 'zh') {
    // Traditional script, or a region that writes it.
    return rest.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh';
  }
  if (primary === 'no' || primary === 'nn') return 'nb';
  return SIGN_IN_LANGUAGES.find((language) => language.toLowerCase() === primary) ?? null;
}

/**
 * The browser's first language the pages speak, by its weights. Without one, the app's
 * own language, and English last.
 */
export function pickLanguage(acceptLanguage: string | string[] | undefined, fallback?: string): SignInLanguage {
  const header = (Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage ?? '').slice(0, MAX_ACCEPT_LANGUAGE);
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';');
      const q = params.map((param) => /^\s*q=([\d.]+)\s*$/i.exec(param)?.[1]).find((value) => value !== undefined);
      return { tag, weight: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.weight > 0 && !Number.isNaN(entry.weight))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const language = known(tag);
    if (language) return language;
  }
  return (fallback && known(fallback)) || 'en';
}

export function wordsFor(language: SignInLanguage): SignInWords {
  return STRINGS[language];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

const hashOf = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The webmail's standard theme (app/globals.css: :root and .dark), and its sign-in card
 * (app/(main)/[locale]/login/page.tsx), as the shell's welcome page has them.
 */
const STYLE = [
  ':root{color-scheme:light dark;--background:#ffffff;--foreground:#0f172a;--muted:#f1f5f9;--muted-foreground:#59687c;--border:#e2e8f0;--ring:#2563eb;--primary:#185aea;--primary-foreground:#ffffff;--destructive:#dc2626;--info:#3b82f6;--logo:#db2d54;--shadow:rgb(0 0 0/.05);--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif}',
  '@media (prefers-color-scheme:dark){:root{--background:#0a0a0a;--foreground:#fafafa;--muted:#262626;--muted-foreground:#adadad;--border:rgba(128,128,128,.3);--ring:#d4d4d4;--primary:#fafafa;--primary-foreground:#171717;--destructive:#ef4444;--info:#60a5fa;--shadow:rgb(0 0 0/.2)}}',
  'html,body{margin:0}',
  'body{box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font:15px/1.5 var(--font);color:var(--foreground);background:linear-gradient(to bottom right,var(--background),color-mix(in srgb,var(--muted) 10%,var(--background)),color-mix(in srgb,var(--muted) 30%,var(--background)));-webkit-font-smoothing:antialiased}',
  '.card{box-sizing:border-box;width:100%;max-width:440px;padding:32px;border:1px solid color-mix(in srgb,var(--border) 60%,transparent);border-radius:16px;background:color-mix(in srgb,var(--background) 80%,transparent);box-shadow:0 20px 25px -5px var(--shadow),0 8px 10px -6px var(--shadow)}',
  '.logo{display:block;width:64px;height:64px;margin:8px auto 20px;fill:var(--logo)}',
  'h1{margin:0;text-align:center;font-size:1.5rem;line-height:2rem;font-weight:600;letter-spacing:-.025em}',
  '.lead{margin:6px 0 0;text-align:center;font-size:.875rem;line-height:1.25rem;color:var(--muted-foreground);overflow-wrap:anywhere}',
  '.notice{--tone:var(--destructive);display:flex;align-items:flex-start;gap:12px;margin-top:20px;padding:12px;border:1px solid color-mix(in srgb,var(--tone) 20%,transparent);border-radius:12px;background:color-mix(in srgb,var(--tone) 5%,transparent)}',
  '.notice.info{--tone:var(--info)}',
  '.notice-icon{flex:none;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;color:var(--tone);background:color-mix(in srgb,var(--tone) 15%,transparent)}',
  '.notice-icon svg{width:20px;height:20px}',
  '.notice p{align-self:center;margin:0;font-size:.875rem;line-height:1.43;color:var(--tone)}',
  '.close{margin:20px 0 0;text-align:center;font-size:.875rem;line-height:1.25rem;color:var(--muted-foreground)}',
  '.button{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;height:44px;margin-top:20px;padding:0 16px;border:1px solid transparent;border-radius:12px;font:inherit;font-size:.9375rem;font-weight:500;text-decoration:none;cursor:pointer;color:var(--primary-foreground);background:var(--primary);box-shadow:0 4px 6px -1px color-mix(in srgb,var(--primary) 15%,transparent);outline:none;transition:background-color .2s,box-shadow .2s}',
  '.button:hover{background:color-mix(in srgb,var(--primary) 90%,transparent)}',
  '.button:focus-visible{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--ring)}',
  'form{margin-top:24px}',
  'label{display:block;margin:16px 0 6px;font-size:.875rem;font-weight:500}',
  'label:first-of-type{margin-top:0}',
  'input:not([type=hidden]){display:block;box-sizing:border-box;width:100%;height:44px;padding:0 14px;font:inherit;font-size:.9375rem;color:var(--foreground);background:color-mix(in srgb,var(--muted) 40%,transparent);border:1px solid color-mix(in srgb,var(--border) 60%,transparent);border-radius:12px;outline:none;transition:background-color .2s,border-color .2s,box-shadow .2s}',
  'input:focus{background:var(--background);border-color:color-mix(in srgb,var(--primary) 50%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent)}',
  '@media (forced-colors:active){.card{border-color:CanvasText}.logo{fill:CanvasText}}',
].join('');

/** Takes code and state out of the address bar, so they stay out of history and screenshots. */
const STRIP_SCRIPT = "(()=>{try{const u=new URL(location.href);for(const k of ['code','state','iss','session_state'])u.searchParams.delete(k);history.replaceState(null,'',u.pathname+u.search+u.hash)}catch{}})();";

export const STYLE_HASH = hashOf(STYLE);
export const SCRIPT_HASH = hashOf(STRIP_SCRIPT);

/** The policy for a page: its style and its script by hash, and nothing else. */
export function pageCsp(withScript: boolean): string {
  return [
    "default-src 'none'",
    `style-src ${STYLE_HASH}`,
    ...(withScript ? [`script-src ${SCRIPT_HASH}`] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The app icon's artwork (the branding repo's favicon), in one path. */
const LOGO = '<svg class="logo" viewBox="0 0 1000 1000" role="img" aria-label="Bulwark"><path d="M 483.028 563.647 L 63.713 187.183 C 59.029 182.978 55.226 174.454 55.226 168.159 L 55.226 122.542 C 55.226 116.247 60.206 109.988 66.339 108.573 L 215.181 74.225 C 221.314 72.809 226.293 76.77 226.293 83.065 L 226.293 176.92 L 352.034 147.895 C 358.167 146.479 363.147 140.219 363.147 133.925 L 363.147 51.483 C 363.147 45.189 368.126 38.93 374.259 37.514 L 488.888 11.061 C 495.021 9.646 504.979 9.646 511.112 11.061 L 625.741 37.514 C 631.874 38.93 636.853 45.189 636.853 51.483 L 636.853 133.925 C 636.853 140.219 641.833 146.479 647.966 147.895 L 773.707 176.92 L 773.707 83.065 C 773.707 76.77 778.686 72.809 784.819 74.225 L 933.661 108.573 C 939.794 109.988 944.774 116.247 944.774 122.542 L 944.774 168.159 C 944.774 174.454 940.971 182.978 936.287 187.183 L 516.972 563.647 C 507.605 572.056 492.395 572.056 483.028 563.647 Z M 944.774 332.832 L 944.774 396.969 C 944.774 403.263 941.16 411.987 936.709 416.437 L 884.411 468.736 C 879.96 473.186 876.347 481.91 876.347 488.204 L 876.347 682.08 C 876.345 718.462 866.664 750.017 847.953 778.668 L 658.833 589.547 L 944.774 332.832 Z M 55.226 332.832 L 55.226 385.564 C 55.226 398.153 62.453 415.6 71.355 424.501 L 107.525 460.671 C 116.426 469.573 123.653 487.02 123.653 499.609 L 123.653 682.08 C 123.655 718.462 133.336 750.017 152.047 778.668 L 341.167 589.547 L 55.226 332.832 Z M 765.645 857.641 C 701.996 901.327 612.26 941.932 500 990 Q 500 990 500 990 C 387.74 941.932 298.004 901.327 234.355 857.641 L 427.917 664.079 C 435.604 668.703 443.74 672.579 452.215 675.636 C 467.543 681.179 483.703 684.007 500 683.996 C 516.297 684.007 532.457 681.179 547.785 675.636 C 556.261 672.579 564.396 668.703 572.083 664.079 L 765.645 857.641 Z"/></svg>';

/** Tabler's alert-circle and info-circle, as the webmail's sign-in errors use them. */
const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/></svg>';

/** Where "Open Bulwark" goes: the app's own scheme, which brings it forward on the inbox. */
export const OPEN_APP_LINK = 'bulwark://inbox';

function notice(text: string, tone: 'error' | 'info'): string {
  const role = tone === 'error' ? 'alert' : 'status';
  return `<div class="notice${tone === 'info' ? ' info' : ''}" role="${role}"><span class="notice-icon">${tone === 'info' ? ICON_INFO : ICON_ALERT}</span><p>${escapeHtml(text)}</p></div>`;
}

function document(language: SignInLanguage, title: string, body: string, withScript: boolean): string {
  const dir = RTL.has(language) ? 'rtl' : 'ltr';
  const script = withScript ? `<script>${STRIP_SCRIPT}</script>` : '';
  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>${STYLE}</style></head><body><main class="card">${LOGO}${body}</main>${script}</body></html>`;
}

/** What a redirect or a password sign-in ended in: what happened, what to do, and the way back. */
export function outcomePage(language: SignInLanguage, outcome: SignInOutcome, address?: string): string {
  const words = wordsFor(language);
  const parts: Record<SignInOutcome, { title: string; lead?: string; error?: string }> = {
    done: { title: words.doneTitle, lead: address ? fill(words.doneAs, { address }) : undefined },
    declined: { title: words.declinedTitle, lead: words.declinedText },
    failed: { title: words.failedTitle, error: words.tryAgain },
    used: { title: words.usedTitle, error: words.usedText },
    expired: { title: words.expiredTitle, error: words.startAgain },
  };
  const { title, lead, error } = parts[outcome];
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    lead ? `<p class="lead">${escapeHtml(lead)}</p>` : '',
    error ? notice(error, 'error') : '',
    `<p class="close">${escapeHtml(words.closeTab)}</p>`,
    `<a class="button" href="${OPEN_APP_LINK}">${escapeHtml(words.openApp)}</a>`,
  ].join('');
  return document(language, title, body, true);
}

export interface FormPageInput {
  host: string;
  nonce: string;
  username: string;
  /** What the app's login said about the last post. */
  problem: 'wrongPassword' | 'codeNeeded' | 'noAnswer' | null;
  needsCode: boolean;
}

/** The password form, for a server with no OAuth. */
export function formPage(language: SignInLanguage, input: FormPageInput): string {
  const words = wordsFor(language);
  const title = fill(words.formTitle, { server: input.host });
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="lead">${escapeHtml(fill(words.formIntro, { server: input.host }))}</p>`,
    input.problem ? notice(words[input.problem], input.problem === 'codeNeeded' ? 'info' : 'error') : '',
    '<form method="post" autocomplete="on">',
    `<input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}">`,
    `<label for="username">${escapeHtml(words.username)}</label>`,
    `<input id="username" name="username" type="text" autocomplete="username" spellcheck="false" autocapitalize="off" dir="ltr" required autofocus value="${escapeHtml(input.username)}">`,
    `<label for="password">${escapeHtml(words.password)}</label>`,
    '<input id="password" name="password" type="password" autocomplete="current-password" dir="ltr" required>',
    input.needsCode ? `<label for="totp">${escapeHtml(words.code)}</label><input id="totp" name="totp" type="text" inputmode="numeric" maxlength="8" autocomplete="one-time-code" dir="ltr" required>` : '',
    `<button class="button" type="submit">${escapeHtml(words.submit)}</button>`,
    '</form>',
  ].join('');
  return document(language, title, body, false);
}
