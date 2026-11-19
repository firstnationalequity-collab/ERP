// Pure helpers behind DataTable, DocForm, RefSelect and the Excel export (M2 task 9).
import { describe, expect, it } from 'vitest';
import { CreateCustomerRequest, UpdateCustomerRequest } from '@albert/shared';
import { buildQuery, pageCount } from './query';
import { EXPORT_MAX_ROWS, EXPORT_NUM_FMT, exportFileName, toCell, toSheetRows } from './excel';
import { apiFieldErrors, changedKeys, prepareValues } from './formValues';
import { refLabel } from './labels';

describe('list query strings', () => {
  it('leaves out empty values and keeps the rest', () => {
    expect(buildQuery({ page: 2, pageSize: 25, search: '', status: undefined, type: null, active: 'active' })).toBe('?page=2&pageSize=25&active=active');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ search: 'Para & Co' })).toBe('?search=Para+%26+Co');
  });

  it('counts pages for the export loop', () => {
    expect([pageCount(0, 200), pageCount(1, 200), pageCount(200, 200), pageCount(201, 200)]).toEqual([1, 1, 1, 2]);
  });
});

describe('Excel export', () => {
  type Row = { code: string; price: string; qty: string };
  const cols = [
    { title: 'Code', value: (r: Row) => r.code },
    { title: 'Price', value: (r: Row) => r.price, format: 'money' as const },
    { title: 'Qty', value: (r: Row) => r.qty, format: 'quantity' as const },
  ];

  it('owner Q19: money and quantity columns become numeric cells; other columns stay text', () => {
    const rows: Row[] = [
      { code: '00123', price: '1500000.50', qty: '12.3456' },
      { code: 'RM-2', price: '-0.10', qty: '0' },
      { code: 'RM-3', price: '', qty: 'n/a' },
    ];
    expect(toSheetRows(cols, rows)).toEqual([
      ['Code', 'Price', 'Qty'],
      ['00123', 1500000.5, 12.3456], // a code with leading zeros stays text
      ['RM-2', -0.1, 0],
      ['RM-3', null, 'n/a'], // empty → empty cell; a non-decimal is never turned into 0 or NaN
    ]);
  });

  it('formats money 0.00, quantity 0.0000 and text @', () => {
    expect(EXPORT_NUM_FMT).toEqual({ money: '0.00', quantity: '0.0000', text: '@' });
    expect([toCell('7', 'text'), toCell(' 7.25 ', 'money'), toCell(null, 'quantity'), toCell(undefined)]).toEqual(['7', 7.25, null, '']);
  });

  it('keeps the 20,000-row export cap', () => {
    expect(EXPORT_MAX_ROWS).toBe(20_000);
  });

  it('names the file with the Karachi date in DD-MM-YYYY and no characters Windows refuses', () => {
    expect(exportFileName('Items', '2026-11-18')).toBe('Items 18-11-2026.xlsx');
    expect(exportFileName('A/B: C?', '2026-01-02')).toBe('A_B_ C_ 02-01-2026.xlsx');
  });
});

describe('DocForm values', () => {
  const fields = [{ name: 'name' }, { name: 'ntn', nullable: true }, { name: 'strn', nullable: true }, { name: 'paymentTermsDays' }];

  it('create: trims text and leaves empty fields out', () => {
    expect(prepareValues({ name: '  City Pharmacy ', ntn: '1234567', strn: '', paymentTermsDays: 0, extra: 'x' }, fields, 'create')).toEqual({
      name: 'City Pharmacy',
      ntn: '1234567',
      paymentTermsDays: 0,
    });
  });

  it('edit: an emptied nullable field is sent as null (clears it); an emptied required one is left out', () => {
    expect(prepareValues({ name: '', ntn: '', strn: 'ABC12', paymentTermsDays: 30 }, fields, 'edit')).toEqual({ ntn: null, strn: 'ABC12', paymentTermsDays: 30 });
  });

  it('edit forms send only what changed', () => {
    const initial = prepareValues({ name: 'City', ntn: '1234567', strn: '', paymentTermsDays: 30 }, fields, 'edit');
    const now = prepareValues({ name: 'City', ntn: '', strn: '', paymentTermsDays: 45 }, fields, 'edit');
    expect(changedKeys(now, initial).sort()).toEqual(['ntn', 'paymentTermsDays']);
    expect(changedKeys(initial, initial)).toEqual([]);
  });

  it('prepared values validate against the same shared schema the API uses', () => {
    const create = prepareValues({ code: 'cust-1', name: 'City', ntn: '', cnic: '', creditLimit: '100000' }, [{ name: 'code' }, { name: 'name' }, { name: 'ntn' }, { name: 'cnic' }, { name: 'creditLimit' }], 'create');
    const refused = CreateCustomerRequest.safeParse(create);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({ path: ['ntn'], message: 'NTN or CNIC is required' });
    expect(CreateCustomerRequest.parse({ ...create, ntn: '1234567-8' })).toMatchObject({ code: 'CUST-1', ntn: '1234567-8' });
    // An edit that clears the STRN sends null, which the update schema accepts.
    expect(UpdateCustomerRequest.parse(prepareValues({ strn: '' }, [{ name: 'strn', nullable: true }], 'edit'))).toEqual({ strn: null });
  });

  it('maps API field errors onto the form fields it knows', () => {
    const details = { formErrors: [], fieldErrors: { ntn: ['NTN: 7 digits'], other: ['x'], strn: [] } };
    expect(apiFieldErrors(details, ['ntn', 'strn'])).toEqual({ ntn: 'NTN: 7 digits' });
    expect(apiFieldErrors(undefined, ['ntn'])).toEqual({});
  });
});

describe('record labels', () => {
  it('shows code — name for the usual master shapes', () => {
    expect(refLabel({ id: '1', code: 'RM-1', name: 'Paracetamol' })).toBe('RM-1 — Paracetamol');
    expect(refLabel({ id: '2', itemCode: 'FG-1', itemName: 'Tabs' })).toBe('FG-1 — Tabs');
    expect(refLabel({ id: '3', productItemCode: 'FG-1', version: 2 })).toBe('#3 v2');
    expect(refLabel({ id: '4', code: 'KG' })).toBe('KG');
    expect(refLabel(undefined)).toBe('');
  });
});
