import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'control-plane/dist-runtime');
const sourceRoot = resolve(process.argv[3] ?? 'control-plane/src');
const packagePath = resolve(process.argv[4] ?? 'control-plane/package.json');
const files = [];

const visit = async (directory, output, relativeTo) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path, output, relativeTo);
    else output.push(relative(relativeTo, path).split(sep).join('/'));
  }
};

await visit(root, files, root);

const sourceFiles = [];
await visit(sourceRoot, sourceFiles, sourceRoot);
const productionSources = sourceFiles.filter((file) =>
  file.endsWith('.ts') && !file.startsWith('test-support/') &&
  !file.endsWith('.test.ts') && !file.endsWith('.integration.test.ts'));
const expectedModules = productionSources.flatMap((file) => {
  const stem = file.slice(0, -'.ts'.length);
  return [`${stem}.js`, `${stem}.d.ts`];
}).sort();
const actualModules = files.filter((file) => file.endsWith('.js') || file.endsWith('.d.ts')).sort();
const missingModules = expectedModules.filter((file) => !actualModules.includes(file));
const unexpectedModules = actualModules.filter((file) => !expectedModules.includes(file));
if (missingModules.length > 0 || unexpectedModules.length > 0) {
  throw new Error(
    `control-plane runtime module mismatch; missing=${missingModules.join(',')}; ` +
    `unexpected=${unexpectedModules.join(',')}`
  );
}

const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
for (const field of ['main', 'types']) {
  const configured = packageManifest[field];
  if (typeof configured !== 'string' || !configured.startsWith('dist/')) {
    throw new Error(`control-plane package ${field} must target dist/`);
  }
  if (!files.includes(configured.slice('dist/'.length))) {
    throw new Error(`control-plane runtime distribution is missing package ${field}: ${configured}`);
  }
}

const forbiddenPaths = files.filter((file) =>
  file.startsWith('test-support/') || file.includes('.test.') || file.includes('.integration.test.'));
if (forbiddenPaths.length > 0) {
  throw new Error(`control-plane runtime distribution contains test files: ${forbiddenPaths.join(', ')}`);
}

const authorityMarkers = ['test-upstream-schema-authority', 'test-canary-policy', 'test-provenance-verifier'];
for (const file of files) {
  const content = await readFile(resolve(root, file), 'utf8');
  const marker = authorityMarkers.find((candidate) => content.includes(candidate));
  if (marker !== undefined) throw new Error(`control-plane runtime distribution contains ${marker} in ${file}`);
}

process.stdout.write(`${JSON.stringify({
  schema_version: 'talos.runtime-distribution-check/v1',
  files: files.length,
  production_modules: productionSources.length
})}\n`);
