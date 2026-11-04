// Another app holding a global shortcut, for test/quick-compose.spec.ts. Says `held` once it has
// the keys named last on its command line, and stays until killed.
const { app, globalShortcut } = require('electron');

app.whenReady().then(() => {
  const held = globalShortcut.register(process.argv.at(-1), () => {});
  console.log(held ? 'held' : 'refused');
});
app.on('window-all-closed', () => {});
