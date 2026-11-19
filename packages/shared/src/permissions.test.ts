// QA-controlled keys (decisions 18-11-2026 "QA-controlled keys"): the countersign rule reads the
// qaControlled flag, never the key prefix, and no approve key may be added without stating it.
import { describe, expect, it } from 'vitest';
import { Permissions, PermissionKeys, QaControlledKeys, isQaControlledKey, type PermissionKey } from './permissions';

const def = (k: PermissionKey): { class: string; qaControlled?: boolean } => Permissions[k];
const statesFlag = (k: PermissionKey): boolean => Object.prototype.hasOwnProperty.call(Permissions[k], 'qaControlled');

describe('qaControlled classification', () => {
  it('every key containing ".approve" under master.* or qc.* states qaControlled deliberately (true or false)', () => {
    const approveKeys = PermissionKeys.filter((k) => (k.startsWith('master.') || k.startsWith('qc.')) && k.includes('.approve'));
    expect(approveKeys.length).toBeGreaterThan(0);
    const missing = approveKeys.filter((k) => !statesFlag(k) || typeof def(k).qaControlled !== 'boolean');
    expect(missing, `add qaControlled: true (qaAction) or { qaControlled: false } to: ${missing.join(', ')}`).toEqual([]);
  });

  it('every qa.* and qc.* action key is QA-controlled', () => {
    const quality = PermissionKeys.filter((k) => (k.startsWith('qa.') || k.startsWith('qc.')) && def(k).class === 'ACTION');
    expect(quality.filter((k) => !isQaControlledKey(k))).toEqual([]);
  });

  it('the GMP approve keys under master.* are QA-controlled', () => {
    for (const k of ['master.avl.approve', 'master.formula.approve', 'master.item.approve'] as const) {
      expect(isQaControlledKey(k)).toBe(true);
    }
  });

  it('the FG output checker key is QA-controlled (owner Q17, 2026-11-19): it verifies a GMP batch record', () => {
    expect(isQaControlledKey('prod.output.verify')).toBe(true);
  });

  it('commercial approve keys are deliberately not QA-controlled', () => {
    for (const k of ['master.customer.approve', 'master.vendor.approve'] as const) {
      expect(statesFlag(k)).toBe(true);
      expect(isQaControlledKey(k)).toBe(false);
    }
  });

  it('only ACTION keys carry qaControlled: true; view keys never trigger the countersign', () => {
    expect(PermissionKeys.filter((k) => def(k).qaControlled === true && def(k).class !== 'ACTION')).toEqual([]);
    expect(isQaControlledKey('qa.view')).toBe(false);
    expect(isQaControlledKey('qc.view')).toBe(false);
  });

  it('QaControlledKeys lists exactly the flagged keys', () => {
    expect([...QaControlledKeys].sort()).toEqual(PermissionKeys.filter((k) => def(k).qaControlled === true).sort());
  });
});
