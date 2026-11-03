// Loaded with -r before main: logs each write that has to come in a set order, and whether
// Local State held the key at that moment.
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const log = process.env.BULWARK_TEST_WRITE_ORDER;
const profile = process.argv.find((arg) => arg.startsWith('--bulwark-user-data=')).split('=')[1];
const { appendFileSync, readFileSync } = fs;

function keyOnDisk() {
  try {
    return Boolean(JSON.parse(readFileSync(path.join(profile, 'Local State'), 'utf8')).os_crypt.encrypted_key);
  } catch {
    return false;
  }
}

for (const [name, targetArg] of [['fsyncSync', -1], ['renameSync', 1], ['rmSync', 0]]) {
  const real = fs[name];
  fs[name] = (...args) => {
    appendFileSync(log, `${name} ${targetArg < 0 ? '' : path.basename(String(args[targetArg]))} key=${keyOnDisk()}\n`);
    return real(...args);
  };
}
syncBuiltinESMExports();
