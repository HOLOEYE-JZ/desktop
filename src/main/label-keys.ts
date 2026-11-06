/** Plain text keys the webmail may translate, so the menus speak all its languages. No Electron here, so tests can load it. */
export const LABEL_KEY = /^(menu|context|tray|leave|stay|closeAnyway|closeNow|unsaved|unsent|update|certificate|signIn|print)/;

/**
 * What a label has to keep. A page sets these through `shell.setLanguages`, so the picker's title
 * could otherwise name no server, or the wrong one in plain words.
 */
const MUST_KEEP: Record<string, readonly string[]> = {
  certificateTitle: ['{host}'],
  certificateRemember: ['{host}'],
  certificateIssued: ['{issuer}', '{date}'],
  contextSearchMail: ['{text}'],
  printPagesMany: ['{count}'],
  printPagesInvalid: ['{count}'],
};

export function labelKeepsPlaceholders(key: string, value: string): boolean {
  return (MUST_KEEP[key] ?? []).every((placeholder) => value.includes(placeholder));
}
