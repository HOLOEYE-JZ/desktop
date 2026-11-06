// Runs in a window station of its own (own-window-station.ps1), so the clipboard it writes is
// never the user's. Puts files on the clipboard through the native helper, then reads them back
// as another program would, and prints both as JSON.
//
//   node clipboard-check.cjs <bulwark-native.node> <file>...
const { execFileSync } = require('node:child_process');

const [helper, ...files] = process.argv.slice(2);
const native = require(helper);
const script = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$list = [Windows.Forms.Clipboard]::GetFileDropList()',
  "$effect = [Windows.Forms.Clipboard]::GetData('Preferred DropEffect')",
  '$byte = if ($effect) { $effect.ReadByte() } else { -1 }',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'ConvertTo-Json -Compress @{ files = @($list); effect = $byte }',
].join('; ');
const read = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], { encoding: 'utf8', windowsHide: true }));

(async () => {
  const before = read();
  await native.clipboardWriteFiles(files);
  console.log(JSON.stringify({ before, after: read() }));
})().catch((error) => {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(1);
});
