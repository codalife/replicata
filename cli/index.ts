import './preload.js';  // MUST be first — see preload.ts
import { ReplicataRuntime, CdpConnectError } from '../core/runtime.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CDP_PORT = 9222;
const CHROME_PROFILE = path.join(os.homedir(), '.replicata', 'chrome-profile');


function findChromeBinary(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  } else {
    // Linux + others: try common names via $PATH.
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      candidates.push(name);
    }
  }
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (fs.existsSync(c)) return c;
    } else {
      // PATH lookup — try `which`/`where`
      try {
        const which = spawn(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
        // Synchronous-ish: skip, use execSync
        const { execSync } = require('child_process');
        const out = execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} ${c}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (out) return out.split('\n')[0];
      } catch {}
    }
  }
  return null;
}

function runChrome(): void {
  const chrome = findChromeBinary();
  if (!chrome) {
    console.error('Could not find Chrome or Chromium. Install Google Chrome, or pass --chrome-path <path>.');
    process.exit(1);
  }
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  console.log(`launching Chrome (${chrome})`);
  console.log(`  profile: ${CHROME_PROFILE}`);
  console.log(`  debug port: ${CDP_PORT}`);
  console.log();
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('Chrome launched. Leave this tab open + run `replicata` in another shell.');
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'chrome') { runChrome(); return; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log('Usage:');
    console.log('  replicata           start the replicata server + ui');
    console.log('  replicata chrome    launch a dedicated Chrome w/ remote debugging');
    console.log('  replicata --help    this message');
    return;
  }

  console.log('replicata starting...');
  console.log();

  const runtime = new ReplicataRuntime({});

  runtime.on('connecting', (attempt, delay) => {
    if (attempt === 1) console.log(`waiting for Chrome (run \`replicata chrome\` in another shell)...`);
    else if (attempt % 4 === 0) console.log(`still waiting for Chrome (attempt ${attempt}, next in ${Math.round(delay)}ms)...`);
  });
  runtime.on('server-ready', (url) => {
    console.log(`replicata server: ${url}`);
    console.log(`replicata ui:     ${url}/ui`);
    console.log();
  });
  runtime.on('chrome-connected', () => console.log('connected to Chrome.'));
  runtime.on('real-app-assigned', (_id, url) => console.log(`real app:  ${url}`));
  runtime.on('real-app-unassigned', () => console.log('real app tab unassigned'));
  runtime.on('renderer-assigned', (_id, url) => console.log(`renderer:  ${url}`));
  runtime.on('renderer-unassigned', () => console.log('renderer tab unassigned'));
  runtime.on('stream-start', (meta) => console.log(`\n stream: ${meta.url}`));
  runtime.on('chunk', (_chunk, meta) => process.stdout.write(`\r  chunks: ${meta.chunks.length}`));
  runtime.on('stream-end', (meta) => {
    const bytes = meta.chunks.reduce((s, c) => s + c.data.length, 0);
    console.log(`\n  done: ${meta.chunks.length} chunks, ${bytes} bytes`);
  });
  runtime.on('ready', () => {
    console.log();
    console.log('ready. open the replicata UI tab and pick your real app + renderer.');
    console.log();
  });

  try {
    await runtime.start();
  } catch (err) {
    if (err instanceof CdpConnectError) {
      console.log();
      console.log(`could not connect to Chrome CDP on port ${err.cdpPort} after multiple retries.`);
      console.log('run:  replicata chrome   (in another shell)');
      process.exit(1);
    }
    throw err;
  }

  process.on('SIGINT', async () => {
    console.log('\nshutting down...');
    await runtime.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('replicata error:', err);
  process.exit(1);
});
