#!/usr/bin/env node
// Launches Electron without ELECTRON_RUN_AS_NODE, which turns it into plain Node.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, process.argv.slice(2), { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
