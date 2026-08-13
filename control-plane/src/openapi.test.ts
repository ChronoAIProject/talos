import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOpenApiPath, loadOpenApiDocument } from './openapi.js';

describe('OpenAPI loader', () => {
  it('loads and converts the repository spec once', () => {
    const document = loadOpenApiDocument();
    expect(defaultOpenApiPath).toContain('specs/talos-openapi.yaml');
    expect(JSON.parse(document.json)).toMatchObject({ openapi: '3.1.0' });
    expect(document.raw).toContain('openapi: 3.1.0');
  });

  it('fails fast for unreadable and invalid specs', () => {
    expect(() => loadOpenApiDocument('/missing/talos-openapi.yaml')).toThrow('failed to load OpenAPI spec');
    const directory = mkdtempSync(join(tmpdir(), 'talos-openapi-'));
    const invalidPath = join(directory, 'invalid.yaml');
    writeFileSync(invalidPath, 'paths: [unterminated');
    expect(() => loadOpenApiDocument(invalidPath)).toThrow('failed to parse OpenAPI spec');
  });
});
