import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const checkOnly = process.argv.includes('--check');
const requestedUrl = process.argv.find(arg => /^(https?:|about:)/.test(arg)) ?? 'about:blank';
const extensionDir = resolve(import.meta.dirname, '..');
const temporaryProfile = checkOnly
  ? await mkdtemp(join(tmpdir(), 'crev-inspector-check-'))
  : null;
const profileDir = temporaryProfile
  ?? process.env.CREV_BROWSER_PROFILE
  ?? join(tmpdir(), 'crev-inspector-dev-profile');
const debugPort = process.env.CREV_BROWSER_PORT;

const args = [
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  ...(debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*'] : []),
];

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: checkOnly,
    // Force the bundled full Chromium: extension support lives there, while Playwright otherwise
    // prefers the smaller headless shell for `headless:true` (which may not be installed).
    executablePath: chromium.executablePath(),
    args,
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;

  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  const app = extensionPage.locator('#app');
  await app.waitFor({ state: 'attached', timeout: 10_000 });

  if (checkOnly) {
    console.log(`CREV Inspector loaded (${extensionId})`);
  } else {
    const target = await context.newPage();
    await target.goto(requestedUrl, { waitUntil: 'domcontentloaded' });
    await target.bringToFront();
    console.log(`CREV Inspector browser ready (${extensionId})`);
    if (debugPort) console.log(`CDP: http://127.0.0.1:${debugPort}`);
    console.log(`Profile: ${profileDir}`);
    await new Promise(resolveClose => context.once('close', resolveClose));
  }
} finally {
  if (checkOnly) await context?.close();
  if (temporaryProfile) await rm(temporaryProfile, { recursive: true, force: true });
}
