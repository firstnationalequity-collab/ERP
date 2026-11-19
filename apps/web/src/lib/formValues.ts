// Pure helpers behind DocForm (tested without a browser).

export type FormMode = 'create' | 'edit';

/** The part of a field definition the value helpers need. */
export interface ValueField {
  name: string;
  /** On edit forms, an emptied field is sent as null (clears it); otherwise empty = not sent. */
  nullable?: boolean;
}

/** UI values → request values: '' becomes null (nullable field on an edit form) or is left out; text is trimmed. */
export function prepareValues(values: Record<string, unknown>, fields: readonly ValueField[], mode: FormMode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty) {
      if (mode === 'edit' && f.nullable) out[f.name] = null;
      continue;
    }
    out[f.name] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** The keys whose value differs from the initial value (edit forms send only these). */
export function changedKeys(values: Record<string, unknown>, initial: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(values), ...Object.keys(initial)]);
  return [...keys].filter((k) => JSON.stringify(values[k] ?? null) !== JSON.stringify(initial[k] ?? null));
}

/** Zod `flatten()` field errors from an API VALIDATION_FAILED → first message per known field. */
export function apiFieldErrors(details: unknown, fieldNames: readonly string[]): Record<string, string> {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors ?? {};
  const out: Record<string, string> = {};
  for (const [name, messages] of Object.entries(fieldErrors)) {
    if (messages?.[0] && fieldNames.includes(name)) out[name] = messages[0];
  }
  return out;
}
