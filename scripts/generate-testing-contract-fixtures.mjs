import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { testingContractFixtureJson } from '../testing-protocol/dist/pql-contract-fixtures.js';

const output = fileURLToPath(new URL('../specs/testing-contract-fixtures.json', import.meta.url));
await writeFile(output, testingContractFixtureJson, 'utf8');
