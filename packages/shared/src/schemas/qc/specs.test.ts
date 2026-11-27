import { describe, expect, it } from 'vitest';
import { compareDecimal, SetSpecTestsRequest, SpecTestInput } from './specs';

describe('compareDecimal', () => {
  it.each([
    ['1', '2', -1],
    ['2.5', '2.50', 0],
    ['-1', '1', -1],
    ['-10.5', '-10.25', -1],
    ['0', '-0.000', 0],
    ['0.1', '0.09', 1],
    ['100', '99.999999', 1],
    ['007', '7', 0],
  ])('%s vs %s', (a, b, out) => {
    expect(compareDecimal(a, b)).toBe(out);
  });
});

describe('SpecTestInput', () => {
  it('needs a limit on a numeric test and min ≤ max', () => {
    expect(SpecTestInput.safeParse({ name: 'Assay', resultType: 'NUMERIC' }).success).toBe(false);
    expect(SpecTestInput.safeParse({ name: 'Assay', resultType: 'NUMERIC', minValue: '102', maxValue: '98' }).success).toBe(false);
    expect(SpecTestInput.safeParse({ name: 'Assay', resultType: 'NUMERIC', minValue: '98', maxValue: '102', isAssay: true }).success).toBe(true);
    expect(SpecTestInput.safeParse({ name: 'Rotation', resultType: 'NUMERIC', minValue: '-15', maxValue: '-10' }).success).toBe(true);
  });
  it('needs a text limit on a text test, and assay / water are numeric', () => {
    expect(SpecTestInput.safeParse({ name: 'ID', resultType: 'TEXT' }).success).toBe(false);
    expect(SpecTestInput.safeParse({ name: 'ID', resultType: 'TEXT', textLimit: 'Complies', isAssay: true }).success).toBe(false);
    expect(SpecTestInput.safeParse({ name: 'ID', resultType: 'TEXT', textLimit: 'Complies' }).success).toBe(true);
  });
  it('allows one assay and one water test', () => {
    const a = { name: 'A', resultType: 'NUMERIC', minValue: '98', isAssay: true };
    expect(SetSpecTestsRequest.safeParse({ tests: [a, { ...a, name: 'B' }] }).success).toBe(false);
  });
});
