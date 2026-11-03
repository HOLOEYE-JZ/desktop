// Loaded with -r before main: native prompts go to a file instead of the screen, from the very
// first moment of a start, which is earlier than a test can reach through Playwright.
const { appendFileSync } = require('node:fs');
const { dialog } = require('electron');

const log = process.env.BULWARK_TEST_PROMPTS;
dialog.showMessageBox = async (...args) => {
  const { message } = args[args.length - 1];
  appendFileSync(log, `${message}\n`);
  return { response: 0, checkboxChecked: false };
};
