import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  digestEnvelopeSchema,
  digestJson,
  terminalReferenceProjectionSchema,
  testingInputReferencesSchema,
  verifyJsonDigest
} from './contracts.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const binding = {
  run_id: 'run-1',
  task_id: 'task-1',
  attempt_id: 'attempt-1',
  generation: 1,
  fence_token: 'fence-token-0001'
};

const reference = (schema: string, ref: string) => ({ schema, ref, digest: digestA });

describe('shared Talos testing contracts', () => {
  it('canonicalizes JSON deterministically and verifies a golden digest', () => {
    const value = { z: 1, a: [true, null] };
    const expected = 'sha256:ca6da02fba3343778761e7785f2b55f7fb17b36ce16eee3492dc392fa7c9deaa';

    expect(canonicalJson(value)).toBe('{"a":[true,null],"z":1}');
    expect(digestJson(value)).toBe(expected);
    expect(verifyJsonDigest(value, expected)).toBe(true);
    expect(verifyJsonDigest({ ...value, z: 2 }, expected)).toBe(false);
    expect(() => digestEnvelopeSchema.parse({
      schema_version: 'talos.canonical-json-envelope/v1',
      value,
      canonical_digest: digestA
    })).toThrow('canonical_digest does not match value');
    expect(() => canonicalJson(Array(2))).toThrow();
    expect(() => canonicalJson('\ud800')).toThrow('valid Unicode');
    expect(() => canonicalJson({ '\udc00': true })).toThrow('valid Unicode');
    const numericGolden: readonly [number, string][] = [
      [-0, '0'],
      [Number.MIN_VALUE, '5e-324'],
      [Number.MAX_VALUE, '1.7976931348623157e+308'],
      [0.000001, '0.000001'],
      [0.0000001, '1e-7'],
      [1e30, '1e+30'],
      [Number.MAX_SAFE_INTEGER, '9007199254740991'],
      [Number.MIN_SAFE_INTEGER, '-9007199254740991']
    ];
    for (const [valueToSerialize, serialized] of numericGolden) {
      expect(canonicalJson(valueToSerialize)).toBe(serialized);
    }
    for (const invalidNumber of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson(invalidNumber)).toThrow();
    }
  });

  it('accepts pointer-only immutable testing inputs and rejects unknown fields', () => {
    const input = {
      schema_version: 'talos.testing-input-references/v1' as const,
      project_pack_snapshot: reference('pql.project-pack-snapshot/v1', 'artifact://pql/project-pack-snapshot/snapshot-1'),
      test_selection: reference('pql.test-selection/v1', 'artifact://pql/test-selection/selection-1'),
      testing_design_input_set: reference('pql.testing-design-input-set.v1', 'artifact://pql/testing-design-input-set/input-set-1'),
      source_revision: {
        repository_id: 'repo-project',
        exact_revision: '0123456789abcdef0123456789abcdef01234567',
        ref: 'artifact://source/revision-1',
        digest: digestA
      },
      structured_plan: reference('testing-structured-plan.v2', 'artifact://plans/plan-1'),
      environment_profile: { ref: 'artifact://environments/environment-1', digest: digestA },
      testing_package: { package_id: 'testing-browser', version: '1.2.3', digest: digestA }
    };

    expect(testingInputReferencesSchema.parse(input)).toEqual(input);
    expect(() => testingInputReferencesSchema.parse({ ...input, raw_plan: {} })).toThrow();
    expect(() => testingInputReferencesSchema.parse({
      ...input,
      structured_plan: { ...input.structured_plan, content: { cases: [] } }
    })).toThrow();
    for (const unsafeRef of [
      'data:application/json,{}',
      'file:///tmp/plan.json',
      '/tmp/plan.json',
      'https://example.com/plan',
      ' artifact://plans/plan-1 ',
      'artifact://user:secret@store/plan-1',
      'artifact://plans/../secret'
    ]) {
      expect(() => testingInputReferencesSchema.parse({
        ...input,
        structured_plan: { ...input.structured_plan, ref: unsafeRef }
      })).toThrow();
    }
    expect(() => testingInputReferencesSchema.parse({
      ...input,
      structured_plan: { ...input.structured_plan, schema: 'testing-structured-plan.v999' }
    })).toThrow();
    expect(() => testingInputReferencesSchema.parse({
      ...input,
      source_revision: { ...input.source_revision, exact_revision: 'main' }
    })).toThrow();
    expect(() => testingInputReferencesSchema.parse({
      ...input,
      testing_package: { ...input.testing_package, version: 'latest' }
    })).toThrow();
  });

  it('rejects terminal references bound to another run or attempt', () => {
    const terminal = {
      schema_version: 'talos.testing-terminal-refs/v1' as const,
      binding,
      case_result_set: {
        ...reference('testing-case-result-set.v2', 'artifact://results/result-1'),
        binding
      },
      evidence_manifest: {
        ...reference('testing-evidence-manifest.v1', 'artifact://results/evidence-1'),
        binding
      },
      cleanup_receipt: {
        ...reference('qa.local-cleanup-receipt/v2', 'artifact://results/cleanup-1'),
        binding
      }
    };

    expect(terminalReferenceProjectionSchema.parse(terminal)).toEqual(terminal);
    const mismatches = {
      run_id: 'other-run',
      task_id: 'other-task',
      attempt_id: 'other-attempt',
      generation: 2,
      fence_token: 'other-fence-token'
    };
    for (const referenceField of ['case_result_set', 'evidence_manifest', 'cleanup_receipt'] as const) {
      for (const [bindingField, mismatch] of Object.entries(mismatches)) {
        expect(() => terminalReferenceProjectionSchema.parse({
          ...terminal,
          [referenceField]: {
            ...terminal[referenceField],
            binding: { ...binding, [bindingField]: mismatch }
          }
        })).toThrow(`${referenceField} binding must match terminal binding`);
      }
    }
    expect(() => terminalReferenceProjectionSchema.parse({ ...terminal, raw_result: {} })).toThrow();
    expect(() => terminalReferenceProjectionSchema.parse({
      ...terminal,
      cleanup_receipt: { ...terminal.cleanup_receipt, digest: 'sha256:bad' }
    })).toThrow();
  });
});
