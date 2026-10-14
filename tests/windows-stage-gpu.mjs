import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const runtime = option('runtime'),
  data = option('data');
if (process.platform !== 'win32' || !runtime || !data) throw new Error('Use Windows Node with --runtime and --data.');
const out = path.join(root, 'out', 'performance');
await mkdir(out, { recursive: true });
// Build tests/stage-gpu-browser.ts as an IIFE named StageGpuTests into this file using the host esbuild.
const compiled = await readFile(path.join(out, 'stage-gpu-tests.js'), 'utf8');
const env = { ...process.env, CHUNI_USER_DATA_DIR: data, CHUNI_DEV_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    executablePath: path.join(runtime, 'ChuniStudio.exe'),
    args: [`--user-data-dir=${data}`],
    cwd: runtime,
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow(),
    cdp = await page.context().newCDPSession(page);
  // The override exists only in this DevTools test target; the shipped CSP stays intact.
  await cdp.send('Page.setBypassCSP', { enabled: true });
  await page.reload();
  await page.addScriptTag({ content: compiled });
  const result = await page.evaluate(() => StageGpuTests.testStageGpu());
  await writeFile(path.join(out, 'stage-gpu-tests.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app?.close();
}
