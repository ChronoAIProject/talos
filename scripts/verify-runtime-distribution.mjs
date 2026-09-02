import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';

const packageConfigurations = {
  'control-plane': {
    excludedSource: (file) => file.startsWith('test-support/')
  },
  worker: {
    excludedSource: (file) => file.startsWith('test-support/')
  },
  'testing-protocol': {
    excludedSource: (file) => file === 'pql-contract-fixtures.ts'
  }
};

const authorityMarkers = [
  'test-upstream-schema-authority',
  'test-canary-policy',
  'test-provenance-verifier',
  'talos.testing-contract-fixtures/v1',
  'external_schema_identities_are_test_only',
  'provider-secret',
  'must-not-cross'
];

const visit = async (directory, output, relativeTo) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path, output, relativeTo);
    else output.push(relative(relativeTo, path).split(sep).join('/'));
  }
};

const runtimeTarget = (value, field) => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.startsWith('./') ? value.slice(2) : value;
  if (!normalized.startsWith('dist/')) throw new Error(`${field} must target dist/`);
  return normalized.slice('dist/'.length);
};

const exportedTargets = (value, field = 'exports') => {
  if (typeof value === 'string') return [runtimeTarget(value, field)];
  if (value === null || typeof value !== 'object') throw new Error(`${field} must contain runtime paths`);
  return Object.entries(value).flatMap(([key, child]) => exportedTargets(child, `${field}.${key}`));
};

export const verifyRuntimeDistribution = async ({ packageName, root, sourceRoot, packagePath }) => {
  const configuration = packageConfigurations[packageName];
  if (configuration === undefined) throw new Error(`unsupported runtime package: ${packageName}`);

  const resolvedRoot = resolve(root);
  const resolvedSourceRoot = resolve(sourceRoot);
  const files = [];
  await visit(resolvedRoot, files, resolvedRoot);

  const sourceFiles = [];
  await visit(resolvedSourceRoot, sourceFiles, resolvedSourceRoot);
  const productionSources = sourceFiles.filter((file) =>
    file.endsWith('.ts') && !file.endsWith('.test.ts') &&
    !file.endsWith('.integration.test.ts') && !configuration.excludedSource(file));
  const expectedModules = productionSources.flatMap((file) => {
    const stem = file.slice(0, -'.ts'.length);
    return [`${stem}.js`, `${stem}.d.ts`];
  }).sort();
  const actualModules = files.filter((file) => file.endsWith('.js') || file.endsWith('.d.ts')).sort();
  const missingModules = expectedModules.filter((file) => !actualModules.includes(file));
  const unexpectedModules = actualModules.filter((file) => !expectedModules.includes(file));
  if (missingModules.length > 0 || unexpectedModules.length > 0) {
    throw new Error(
      `${packageName} runtime module mismatch; missing=${missingModules.join(',')}; ` +
      `unexpected=${unexpectedModules.join(',')}`
    );
  }

  const packageManifest = JSON.parse(await readFile(resolve(packagePath), 'utf8'));
  const manifestTargets = [
    runtimeTarget(packageManifest.main, `${packageName} package main`),
    runtimeTarget(packageManifest.types, `${packageName} package types`)
  ];
  if (typeof packageManifest.bin === 'string') {
    manifestTargets.push(runtimeTarget(packageManifest.bin, `${packageName} package bin`));
  } else if (packageManifest.bin !== undefined) {
    for (const [name, target] of Object.entries(packageManifest.bin)) {
      manifestTargets.push(runtimeTarget(target, `${packageName} package bin.${name}`));
    }
  }
  if (packageManifest.exports !== undefined) {
    manifestTargets.push(...exportedTargets(packageManifest.exports, `${packageName} package exports`));
  }
  for (const target of manifestTargets) {
    if (!files.includes(target)) {
      throw new Error(`${packageName} runtime distribution is missing package target: ${target}`);
    }
  }

  const forbiddenPaths = files.filter((file) =>
    file.startsWith('test-support/') || file.includes('.test.') ||
    file.includes('.integration.test.') || file.includes('pql-contract-fixtures.'));
  if (forbiddenPaths.length > 0) {
    throw new Error(`${packageName} runtime distribution contains forbidden files: ${forbiddenPaths.join(', ')}`);
  }

  for (const file of files) {
    const content = await readFile(resolve(resolvedRoot, file), 'utf8');
    const marker = authorityMarkers.find((candidate) => content.includes(candidate));
    if (marker !== undefined) {
      throw new Error(`${packageName} runtime distribution contains ${marker} in ${file}`);
    }
  }

  return {
    schema_version: 'talos.runtime-distribution-check/v1',
    package: packageName,
    files: files.length,
    production_modules: productionSources.length
  };
};

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [packageName, root, sourceRoot, packagePath] = process.argv.slice(2);
  if (packageName === undefined || root === undefined || sourceRoot === undefined || packagePath === undefined) {
    throw new Error('usage: verify-runtime-distribution <package> <dist> <source> <package.json>');
  }
  process.stdout.write(`${JSON.stringify(await verifyRuntimeDistribution({
    packageName, root, sourceRoot, packagePath
  }))}\n`);
}
