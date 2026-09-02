import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  computeTestingRunSnapshotDigest,
  testingRunSnapshotSchema
} from '@talos/testing-protocol';
import { validateTestingContractFixtureJson } from '../testing-protocol/dist/pql-contract-fixtures.js';

const DEMO_SCHEMA_VERSION = 'talos.testing-contract-demo/v1';
const CANONICAL_TERMINAL_AUTHORITY = 'talos.testing-run-snapshot/v1';
const OPERATIONS = ['get_capabilities', 'submit', 'get', 'events', 'cancel'];
const EXPECTED_FIXTURE_COUNTS = { snapshot: 16, error: 16, protocol: 5, total: 37 };

const fail = (message) => {
  throw new Error(`testing contract demo validation failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const assertEqual = (actual, expected, message) => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
};

const fixturePath = fileURLToPath(
  new URL('../specs/testing-contract-fixtures.json', import.meta.url)
);
const fixtureJson = await readFile(fixturePath, 'utf8');
const bundle = validateTestingContractFixtureJson(fixtureJson);

assert(bundle.side_effects === false, 'fixture bundle must declare side_effects=false');
assertEqual(bundle.operations, OPERATIONS, 'fixture bundle must expose exactly five operations');
assert(
  bundle.canonical_terminal_authority === CANONICAL_TERMINAL_AUTHORITY,
  'fixture bundle canonical terminal authority is not TestingRunSnapshot v1'
);
assert(
  bundle.fixtures.every((fixture) => fixture.side_effects === false),
  'every fixture must declare side_effects=false'
);

const fixtureCounts = bundle.fixtures.reduce(
  (counts, fixture) => {
    counts[fixture.kind] += 1;
    counts.total += 1;
    return counts;
  },
  { snapshot: 0, error: 0, protocol: 0, total: 0 }
);
assertEqual(fixtureCounts, EXPECTED_FIXTURE_COUNTS, 'fixture counts do not match the reviewed bundle');

const snapshotFixtures = new Map();
for (const fixture of bundle.fixtures) {
  if (fixture.kind !== 'snapshot') continue;

  const parsed = testingRunSnapshotSchema.parse(fixture.response);
  const { snapshot_digest: snapshotDigest, resume_cursor: _resumeCursor, ...snapshotCore } = parsed;
  assert(
    computeTestingRunSnapshotDigest(snapshotCore) === snapshotDigest,
    `${fixture.id} snapshot digest does not match its canonical core`
  );

  const controlClosed = ['completed', 'failed', 'cancelled', 'abandoned'].includes(parsed.control_status);
  const outcomesSettled = parsed.execution_outcome !== 'executing' &&
    parsed.evidence_outcome !== 'staging' &&
    parsed.upload_outcome !== 'pending' &&
    parsed.cleanup_outcome !== 'pending';
  assert(
    parsed.terminal === (controlClosed && outcomesSettled),
    `${fixture.id} terminal flag does not match the canonical terminal constraint`
  );
  snapshotFixtures.set(fixture.id, parsed);
}

const scenarioSpecifications = [
  {
    id: 'passed',
    outcomes: {
      control_status: 'completed',
      execution_outcome: 'passed',
      evidence_outcome: 'complete',
      upload_outcome: 'uploaded',
      cleanup_outcome: 'complete'
    },
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false },
    invariant: 'Product assertions passed and all supporting outcomes settled independently.'
  },
  {
    id: 'product_assertion_failed',
    outcomes: {
      control_status: 'completed',
      execution_outcome: 'failed',
      evidence_outcome: 'complete',
      upload_outcome: 'uploaded',
      cleanup_outcome: 'complete'
    },
    summary: { total: 1, passed: 0, failed: 1, blocked: 0, error: 0, skipped: 0, all_skipped: false },
    invariant: 'A settled Talos run preserves the failed product assertion as an execution fact.'
  },
  {
    id: 'all_skipped',
    outcomes: {
      control_status: 'completed',
      execution_outcome: 'all_skipped',
      evidence_outcome: 'complete',
      upload_outcome: 'uploaded',
      cleanup_outcome: 'complete'
    },
    summary: { total: 2, passed: 0, failed: 0, blocked: 0, error: 0, skipped: 2, all_skipped: true },
    invariant: 'All-skipped is terminal and remains distinct from a passing execution.'
  },
  {
    id: 'cleanup_failed',
    outcomes: {
      control_status: 'completed',
      execution_outcome: 'passed',
      evidence_outcome: 'complete',
      upload_outcome: 'uploaded',
      cleanup_outcome: 'residual_blocking'
    },
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0, skipped: 0, all_skipped: false },
    invariant: 'Cleanup failed independently; the passed product assertion was not rewritten.'
  }
];

const projectResultRef = (resultRef) => ({
  schema: resultRef.schema,
  schema_digest: resultRef.schema_digest,
  ref: resultRef.ref,
  digest: resultRef.digest
});

const scenarios = scenarioSpecifications.map((specification) => {
  const snapshot = snapshotFixtures.get(specification.id);
  assert(snapshot !== undefined, `required scenario ${specification.id} is missing`);
  assert(snapshot.terminal === true, `${specification.id} must be canonical terminal`);
  assert(snapshot.terminal_reason !== null, `${specification.id} must have a terminal reason`);

  const outcomes = {
    control_status: snapshot.control_status,
    execution_outcome: snapshot.execution_outcome,
    evidence_outcome: snapshot.evidence_outcome,
    upload_outcome: snapshot.upload_outcome,
    cleanup_outcome: snapshot.cleanup_outcome
  };
  assertEqual(outcomes, specification.outcomes, `${specification.id} outcomes changed`);
  assertEqual(snapshot.summary, specification.summary, `${specification.id} summary changed`);
  assert(snapshot.results !== null, `${specification.id} terminal refs are missing`);

  const { case_result_set: caseResultSet, evidence_manifest: evidenceManifest,
    cleanup_receipt: cleanupReceipt } = snapshot.results;
  assert(caseResultSet !== undefined, `${specification.id} CaseResultSet ref is missing`);
  assert(evidenceManifest !== undefined, `${specification.id} EvidenceManifest ref is missing`);
  assert(cleanupReceipt !== undefined, `${specification.id} CleanupReceipt ref is missing`);

  return {
    id: specification.id,
    terminal: snapshot.terminal,
    terminal_reason: snapshot.terminal_reason.code,
    outcomes,
    snapshot_digest: snapshot.snapshot_digest,
    result_refs: {
      case_result_set: projectResultRef(caseResultSet),
      evidence_manifest: projectResultRef(evidenceManifest),
      cleanup_receipt: projectResultRef(cleanupReceipt)
    },
    invariant: specification.invariant
  };
});

const demo = {
  schema_version: DEMO_SCHEMA_VERSION,
  side_effects: false,
  operations: [...bundle.operations],
  canonical_terminal_authority: bundle.canonical_terminal_authority,
  fixture_counts: fixtureCounts,
  scenarios,
  authority_boundary: {
    talos_exposes_pql_gate_inputs: true,
    talos_computes_release_gate_decision: false,
    external_schema_identities_are_test_only: true,
    statement: 'Talos exposes PQL Release Gate inputs; it does not compute ReleaseGateDecision.'
  }
};

assert(demo.schema_version === DEMO_SCHEMA_VERSION, 'unexpected Demo schema version');
assert(demo.side_effects === false, 'Demo must declare side_effects=false');
assert(demo.scenarios.length === 4, 'Demo must expose exactly four representative scenarios');
assert(demo.authority_boundary.talos_computes_release_gate_decision === false,
  'Talos must not compute ReleaseGateDecision');

const arguments_ = process.argv.slice(2);
assert(arguments_.every((argument) => argument === '--json'), `unknown argument: ${arguments_.join(' ')}`);

if (arguments_.includes('--json')) {
  process.stdout.write(`${JSON.stringify(demo, null, 2)}\n`);
} else {
  console.log('Talos Testing Contract Demo');
  console.log(`Schema: ${demo.schema_version}`);
  console.log(`Side effects: ${demo.side_effects}`);
  console.log(`Operations (${demo.operations.length}): ${demo.operations.join(', ')}`);
  console.log(`Canonical terminal authority: ${demo.canonical_terminal_authority}`);
  console.log(
    `Fixtures: ${fixtureCounts.snapshot} snapshots, ${fixtureCounts.error} errors, ` +
    `${fixtureCounts.protocol} protocol cases (${fixtureCounts.total} total)`
  );
  for (const scenario of demo.scenarios) {
    const outcomes = Object.values(scenario.outcomes).join(' / ');
    console.log(`- ${scenario.id}: ${outcomes}; terminal=${scenario.terminal}`);
    console.log(`  snapshot_digest=${scenario.snapshot_digest}`);
    console.log(`  ${scenario.invariant}`);
  }
  console.log(demo.authority_boundary.statement);
  console.log('External schema identities in these fixtures are test-only, not production authorities.');
}
