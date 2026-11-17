// Company settings (docs/architecture.md §5 core.settings). Each module declares its settings in code with
// a Zod schema and a default (registerSetting); only declared keys can be read or written, and every value
// is validated. Changes need a reason, recorded in the audit log.
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { SettingDto, UpdateSettingRequest } from '@albert/shared';
import { db, withTransaction, type Queryable } from '../../db/client';
import { settings } from '../../db/schema/core';
import { AppError } from '../errors';
import { txContext, type AuthContext } from '../auth/auth.service';

interface SettingDefinition<T> {
  key: string;
  description: string;
  schema: z.ZodType<T>;
  defaultValue: T;
}

const registry = new Map<string, SettingDefinition<unknown>>();

/** Declare a setting (once, at start-up). Key format: <module>.<name>, e.g. purch.grn_tolerance_pct. */
export function registerSetting<T>(def: SettingDefinition<T>): void {
  if (!/^[a-z]+(\.[a-z_]+)+$/.test(def.key)) throw new Error(`Bad setting key ${def.key}`);
  if (registry.has(def.key)) throw new Error(`Setting ${def.key} is already registered`);
  def.schema.parse(def.defaultValue);
  registry.set(def.key, def as SettingDefinition<unknown>);
}

/** Read a setting in a service (inside its transaction, so it sees the same snapshot). */
export async function getSetting<T>(q: Queryable, companyId: string, key: string): Promise<T> {
  const def = registry.get(key);
  if (!def) throw new Error(`Setting ${key} is not registered`);
  const [row] = await q
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.companyId, companyId), eq(settings.key, key)));
  return (row ? def.schema.parse(row.value) : def.defaultValue) as T;
}

export async function listSettings(auth: AuthContext): Promise<SettingDto[]> {
  const rows = await db.select().from(settings).where(eq(settings.companyId, auth.companyId));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return [...registry.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((def) => ({
      key: def.key,
      description: def.description,
      value: stored.has(def.key) ? stored.get(def.key) : def.defaultValue,
      defaultValue: def.defaultValue,
      isDefault: !stored.has(def.key),
    }));
}

export async function updateSetting(auth: AuthContext, key: string, input: UpdateSettingRequest): Promise<SettingDto> {
  const def = registry.get(key);
  if (!def) throw new AppError('NOT_FOUND', `Unknown setting ${key}`);
  const parsed = def.schema.safeParse(input.value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', `Invalid value for ${key}`, parsed.error.flatten());
  }
  await withTransaction(txContext(auth, input.reason), async (tx) => {
    await tx
      .insert(settings)
      .values({ key, value: parsed.data })
      .onConflictDoUpdate({ target: [settings.companyId, settings.key], set: { value: parsed.data } });
  });
  const result = (await listSettings(auth)).find((s) => s.key === key);
  if (!result) throw new AppError('NOT_FOUND', `Unknown setting ${key}`);
  return result;
}
