import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface OpenApiDocument {
  raw: string;
  json: string;
}

export const defaultOpenApiPath = fileURLToPath(
  new URL('../../specs/talos-openapi.yaml', import.meta.url)
);

export const loadOpenApiDocument = (path = defaultOpenApiPath): OpenApiDocument => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`failed to load OpenAPI spec from ${path}: ${errorMessage(error)}`);
  }

  try {
    const document = parse(raw) as unknown;
    return { raw, json: JSON.stringify(document) };
  } catch (error) {
    throw new Error(`failed to parse OpenAPI spec from ${path}: ${errorMessage(error)}`);
  }
};

const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : 'unknown error';
