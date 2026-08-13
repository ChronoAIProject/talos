import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const releaseRoot = resolve(root, 'worker', 'release');
const packageDirectory = resolve(releaseRoot, 'talos-worker');
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const workerPackage = JSON.parse(await readFile(resolve(root, 'worker', 'package.json'), 'utf8'));
const version = process.env.TALOS_WORKER_VERSION ?? workerPackage.version;
const archive = resolve(releaseRoot, `talos-worker-${version}.tar.gz`);
const run = async (command, arguments_) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, arguments_, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolvePromise()
    : reject(new Error(`${command} exited with ${code ?? 'unknown'}`)));
});

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(packageDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, 'worker', 'src', 'cli', 'main.ts')],
  outfile: resolve(packageDirectory, 'talos-worker.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['playwright', 'playwright/*']
});
await chmod(resolve(packageDirectory, 'talos-worker.js'), 0o755);
await writeFile(resolve(packageDirectory, 'package.json'), `${JSON.stringify({
  name: 'talos-worker-release',
  version,
  private: true,
  type: 'module',
  engines: { node: '>=22' },
  dependencies: { playwright: workerPackage.optionalDependencies.playwright }
}, null, 2)}\n`);
await writeFile(resolve(packageDirectory, 'install-manifest.json'), `${JSON.stringify({
  name: 'talos-worker',
  version,
  node: '>=22',
  entrypoint: 'talos-worker.js',
  artifact: basename(archive),
  platformIndependent: true
}, null, 2)}\n`);
await cp(resolve(root, 'docs', 'WORKER.md'), resolve(packageDirectory, 'WORKER.md'));
await run('tar', ['-czf', archive, '-C', releaseRoot, 'talos-worker']);
process.stdout.write(`${archive}\n`);
