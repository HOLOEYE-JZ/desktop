// Loaded with -r before main: no native prompt ever shows, from the very first moment of a
// start, which is earlier than a test can reach through Playwright. Each is recorded and gets
// the answer in globalThis.__answer. -1 is "Esc". `hold` keeps the prompt open until the test
// calls globalThis.__release, or until its signal goes, as a real dialog closes then. With
// `ignoreSignal` it stays open past that: someone clicking at that very moment.
const { dialog } = require('electron');

globalThis.__prompts = [];
globalThis.__answer = JSON.parse(process.env.BULWARK_TEST_PROMPT_ANSWER || '{"response":-1}');
dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1];
  const { message, detail, buttons, defaultId, cancelId, noLink, checkboxLabel, checkboxChecked: ticked, signal } = options;
  const record = { message, detail, buttons, defaultId, cancelId, noLink, checkboxLabel, ticked, closedBySignal: false };
  globalThis.__prompts.push(record);
  let answer = globalThis.__answer;
  if (answer.hold) {
    answer = await new Promise((resolve) => {
      globalThis.__release = resolve;
      if (answer.ignoreSignal) return;
      signal?.addEventListener('abort', () => {
        record.closedBySignal = true;
        resolve({ response: -1 });
      });
    });
  }
  const { response, checkboxChecked = false } = answer;
  return { response: response < 0 ? options.cancelId : response, checkboxChecked };
};
