// Preload for running the browser tests on Windows with the packaged runtime as Node (ELECTRON_RUN_AS_NODE=1):
//   ChuniStudio.exe --experimental-transform-types --import file:///<repo>/tests/windows-node-preload.mjs tests/<test file>
// It resolves extensionless TypeScript imports and points Playwright's chromium at CHUNI_BROWSER (for example installed Edge).
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
if (process.env.CHUNI_BROWSER)
  for (const name of ['playwright', '@playwright/test']) {
    const { chromium } = await import(name),
      launch = chromium.launch.bind(chromium);
    chromium.launch = (options = {}) => launch({ executablePath: process.env.CHUNI_BROWSER, ...options });
  }
