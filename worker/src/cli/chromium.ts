import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

export const installChromium = async (): Promise<void> => {
  const require = createRequire(import.meta.url);
  const cliPath = require.resolve('playwright/cli');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Playwright Chromium installation exited with code ${code ?? 'unknown'}`)));
  });
};
