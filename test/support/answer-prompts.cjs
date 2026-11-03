// Loaded with -r before main: no native prompt ever shows, from the very first moment of a
// start, which is earlier than a test can reach through Playwright. Each is recorded and gets
// the answer in globalThis.__answer. -1 is "Esc".
const { dialog } = require('electron');

globalThis.__prompts = [];
globalThis.__answer = JSON.parse(process.env.BULWARK_TEST_PROMPT_ANSWER || '{"response":-1}');
dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1];
  const { message, detail, buttons, defaultId, cancelId, noLink, checkboxLabel, checkboxChecked: ticked } = options;
  globalThis.__prompts.push({ message, detail, buttons, defaultId, cancelId, noLink, checkboxLabel, ticked });
  const { response, checkboxChecked = false } = globalThis.__answer;
  return { response: response < 0 ? options.cancelId : response, checkboxChecked };
};
