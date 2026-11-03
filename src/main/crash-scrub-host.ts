/**
 * Scrubs one crash file in a utilityProcess of its own and answers with the copy. Main waits
 * for it, with the app still answering. See `scrubInUtility` in features/privacy.ts.
 */

import { readFileSync } from 'node:fs';
import { scrubMinidump, type ScrubNames } from './crash-files';

process.parentPort.once('message', (event: { data: { file: string; names: ScrubNames } }) => {
  try {
    const bytes = scrubMinidump(readFileSync(event.data.file), event.data.names);
    process.parentPort.postMessage({ ok: true, bytes: new Uint8Array(bytes) });
  } catch {
    process.parentPort.postMessage({ ok: false });
  }
});
