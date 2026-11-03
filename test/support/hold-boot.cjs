// Loaded with -r: holds the app's boot until the file named in BULWARK_TEST_BOOT_GATE exists,
// so a test can do something at a moment that is otherwise a race.
const { existsSync } = require('node:fs');
const { app } = require('electron');

// The app reads its arguments for files to open, and this isn't one.
process.argv.splice(process.argv.indexOf('-r'), 2);

const gate = process.env.BULWARK_TEST_BOOT_GATE;
const whenReady = app.whenReady.bind(app);
app.whenReady = () =>
  whenReady().then(
    () =>
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!existsSync(gate)) return;
          clearInterval(timer);
          resolve();
        }, 50);
      }),
  );
