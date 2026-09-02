import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { verifyRuntimeDistribution } from './verify-runtime-distribution.mjs';

const imageKind = process.argv[2];
const appRoot = resolve(process.argv[3] ?? '');
const activePackages = imageKind === 'control-plane'
  ? ['control-plane', 'testing-protocol']
  : imageKind === 'worker'
    ? ['worker', 'testing-protocol']
    : undefined;
if (activePackages === undefined || process.argv[3] === undefined) {
  throw new Error('usage: verify-runtime-image <control-plane|worker> <extracted-app-root>');
}

const ownedFiles = [];
const visitOwned = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visitOwned(path);
    else ownedFiles.push(relative(appRoot, path).split(sep).join('/'));
  }
};
await visitOwned(appRoot);
const forbiddenPaths = ownedFiles.filter((file) =>
  file.includes('.test.') || file.includes('.integration.test.') ||
  file.split('/').includes('test-support') || file.includes('pql-contract-fixtures.') ||
  file.endsWith('testing-contract-fixtures.json'));
if (forbiddenPaths.length > 0) {
  throw new Error(`${imageKind} image contains forbidden Talos-owned paths: ${forbiddenPaths.join(',')}`);
}

const authorityMarkers = [
  'test-upstream-schema-authority',
  'test-canary-policy',
  'test-provenance-verifier',
  'talos.testing-contract-fixtures/v1',
  'external_schema_identities_are_test_only',
  'provider-secret',
  'must-not-cross'
];
for (const file of ownedFiles) {
  const content = await readFile(resolve(appRoot, file), 'utf8');
  const marker = authorityMarkers.find((candidate) => content.includes(candidate));
  if (marker !== undefined) throw new Error(`${imageKind} image contains ${marker} in ${file}`);
}

const results = [];
for (const packageName of activePackages) {
  const packageRoot = resolve(appRoot, packageName);
  const entries = (await readdir(packageRoot)).sort();
  if (entries.join(',') !== 'dist,package.json') {
    throw new Error(`${imageKind} image ${packageName} package has unexpected entries: ${entries.join(',')}`);
  }
  results.push(await verifyRuntimeDistribution({
    packageName,
    root: resolve(packageRoot, 'dist'),
    sourceRoot: resolve(packageName, 'src'),
    packagePath: resolve(packageRoot, 'package.json')
  }));
}

const specsRoot = resolve(appRoot, 'specs');
if (imageKind === 'control-plane') {
  const specs = (await readdir(specsRoot)).sort();
  if (specs.join(',') !== 'talos-openapi.yaml') {
    throw new Error(`control-plane image specs must contain only talos-openapi.yaml: ${specs.join(',')}`);
  }
} else {
  try {
    await readdir(specsRoot);
    throw new Error('worker image must not contain a specs directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

process.stdout.write(`${JSON.stringify({
  schema_version: 'talos.runtime-image-check/v1',
  image: imageKind,
  packages: results
})}\n`);
