// engines/posting — every journal goes through here (CLAUDE.md rule 5 and "Code layout"; architecture §6).
//
//  - postJournal():          a system journal for a business event: accounts from posting_rules (event, role,
//                            item category, else the default rule), created DRAFT, posted only when balanced.
//  - postStockJournal():     the journal for a set of stock movements (engines/inventory), in the SAME transaction
//                            (rule 5); customer-owned / zero-value rows post nothing (rule 12); transfers post
//                            nothing. Then sweeps any lot left empty with value (below).
//  - reverseJournal():       a correction is a mirror entry; the original becomes REVERSED (rule 4).
//  - reverseStockJournal():  the mirror of a stock journal, checked against the reversed movements, then the sweep.
//
// Rounding sweep (owner, 18-11-2026): a lot with zero quantity has zero value. After posting movements or their
// reversal, every own-stock lot they touched that is empty but still carries value gets a value-only
// ROUNDING_SWEEP ledger row (engines/inventory) and a ROUNDING_DIFFERENCE journal against the PLACEHOLDER
// "Rounding difference" account, in the same transaction; the database refuses the commit otherwise (0016).
//
// Runs inside the caller's transaction. Journal status moves go through core/transition (rule 7) with the key of
// the business action the journal belongs to (JournalPostingKeys). System journals take the SJ series and name
// their source document and event (0013); the database re-checks balance, open period (rule 11), immutability
// and the reversal mirror (0012, 0013).
import { Decimal } from 'decimal.js';
import {
  PostingEventRoles,
  PostingStatus,
  type AccountRole,
  type PermissionKey,
  type PostingEvent,
  type StockMovementType,
  type ValueAdjustmentReason,
} from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { AppError, fromDbError } from '../../core/errors';
import { nextDocNo } from '../../core/settings/numbering.service';
import { defineTransitions, recordInitialStatus, transition, type Actor, type TransitionMap } from '../../core/transition/transition';
import { assertTaxRateConfirmed } from '../../modules/masters/catalog.service';
import { movementDocuments, sweepEmptyLot, type PostedMovement } from '../inventory';
import * as repo from './posting.repo';

export const JOURNAL_TABLE = 'fin.journal_entries';
/** System journals (0013): posted by modules, always naming their source document and event. */
export const SYSTEM_JOURNAL_SERIES = 'SJ';

/**
 * The key of the business action each event's journal belongs to: the actor posting (or reversing) the journal
 * must hold it (rule 7: every move names its key). Architecture §4: "Each module's map lists its keys when that
 * module is built" — events of later milestones (landed cost, invoices, payments, receipts, conversion) are
 * added with their module. ROUNDING_DIFFERENCE is posted with the key of the movements that left the paisa.
 * Owner — confirmed 2026-11-18 (each key checked against docs/roles.md): FG_OUTPUT is the output-verification key
 * (Q8; doer + checker Option A, owner 2026-11-18: the checker's verify posts it), FG_COST_ADJUSTMENT the batch-close key, SALES_RETURN_RECEIPT the returns-receipt key (Q9).
 */
export const JournalPostingKeys: Readonly<Partial<Record<PostingEvent, PermissionKey>>> = {
  GRN_RECEIPT: 'purch.grn.post',
  MATERIAL_ISSUE: 'inv.movement.post',
  MATERIAL_RETURN: 'inv.movement.post',
  FG_OUTPUT: 'prod.output.verify',
  FG_COST_ADJUSTMENT: 'prod.batch.approve_close',
  DISPATCH: 'fg.dispatch.post',
  SALES_RETURN_RECEIPT: 'fg.delivery.manage',
  STOCK_ADJUSTMENT: 'inv.adjustment.approve',
  LOT_DESTROYED: 'inv.lot.dispose',
  LOT_RETURNED: 'inv.lot.dispose',
};

type Posting = { event: PostingEvent; counter: AccountRole };

/**
 * Stock movement type → posting event and the account role on the other side of INVENTORY (architecture §6).
 * Not here: transfers (no journal) and VALUE_ADJUSTMENT (its event follows its reason: ValueAdjustmentPosting).
 */
export const StockMovementPosting: Readonly<Partial<Record<StockMovementType, Posting>>> = {
  RECEIPT: { event: 'GRN_RECEIPT', counter: 'GRNI' },
  ISSUE: { event: 'MATERIAL_ISSUE', counter: 'WIP' },
  ISSUE_RETURN: { event: 'MATERIAL_RETURN', counter: 'WIP' },
  OUTPUT: { event: 'FG_OUTPUT', counter: 'WIP' },
  DISPATCH: { event: 'DISPATCH', counter: 'COGS' },
  SALES_RETURN: { event: 'SALES_RETURN_RECEIPT', counter: 'COGS' },
  ADJUSTMENT_IN: { event: 'STOCK_ADJUSTMENT', counter: 'INVENTORY_GAIN' },
  ADJUSTMENT_OUT: { event: 'STOCK_ADJUSTMENT', counter: 'INVENTORY_LOSS' },
  DESTROY: { event: 'LOT_DESTROYED', counter: 'REJECTION_WRITE_OFF' },
  RETURN_TO_VENDOR: { event: 'LOT_RETURNED', counter: 'ACCOUNTS_PAYABLE' },
  ROUNDING_SWEEP: { event: 'ROUNDING_DIFFERENCE', counter: 'ROUNDING_DIFFERENCE' },
};

/** VALUE_ADJUSTMENT reason → posting event and counter role (owner Q8, 2026-11-18). M3 adds LANDED_COST. */
export const ValueAdjustmentPosting: Readonly<Record<ValueAdjustmentReason, Posting>> = {
  BATCH_CLOSE: { event: 'FG_COST_ADJUSTMENT', counter: 'WIP' },
};

/** The event and counter role of one movement (undefined: no posting rule). */
export function movementPosting(m: Pick<PostedMovement, 'movementType' | 'reasonCode'>): Posting | undefined {
  if (m.movementType === 'VALUE_ADJUSTMENT') {
    return ValueAdjustmentPosting[m.reasonCode as ValueAdjustmentReason];
  }
  return StockMovementPosting[m.movementType];
}

const journalMaps = new Map<PermissionKey, TransitionMap<PostingStatus>>();
/** One complete map per key, so each move names exactly one key (as for lot creation in engines/inventory). */
function journalMap(key: PermissionKey): TransitionMap<PostingStatus> {
  let map = journalMaps.get(key);
  if (!map) {
    map = defineTransitions<PostingStatus>({
      entityTable: JOURNAL_TABLE,
      statuses: PostingStatus,
      moves: [
        { from: null, to: 'DRAFT', permission: key },
        { from: 'DRAFT', to: 'POSTED', permission: key },
        { from: 'POSTED', to: 'REVERSED', permission: key, reasonRequired: true },
      ],
    });
    journalMaps.set(key, map);
  }
  return map;
}

function postingKey(event: PostingEvent): PermissionKey {
  const key = JournalPostingKeys[event];
  if (!key) {
    throw new AppError('VALIDATION_FAILED', `No posting key is defined for ${event} journals yet; its module adds it when it is built`, { event });
  }
  return key;
}

// ---------------------------------------------------------------- types

export interface LineDimensions {
  costCenterId?: string;
  customerId?: string;
  vendorId?: string;
  productionOrderId?: string;
}

export interface JournalLineInput extends LineDimensions {
  role: AccountRole;
  /** Picks the item category's rule, else the default rule (no category). */
  itemCategoryId?: string | null;
  /** Exactly one of debit / credit is > 0; 2 decimals. */
  debit?: string;
  credit?: string;
  /** The tax this line books; a WITHHOLDING code must be confirmed by Finance (0013). */
  taxCodeId?: string;
  narration?: string;
}

export interface JournalInput {
  event: PostingEvent;
  /** The source document, e.g. GRN 42. */
  sourceType: string;
  sourceId: string;
  /** Entry date (YYYY-MM-DD); its period must be OPEN (rule 11). */
  date: string;
  narration: string;
  lines: JournalLineInput[];
}

export interface JournalLine {
  lineNo: number;
  accountId: string;
  debit: string;
  credit: string;
  costCenterId: string | null;
  customerId: string | null;
  vendorId: string | null;
  productionOrderId: string | null;
  taxCodeId: string | null;
  narration: string | null;
}

export interface JournalEntry {
  id: string;
  docNo: string;
  entryDate: string;
  periodId: string;
  sourceType: string;
  sourceId: string | null;
  event: PostingEvent | null;
  narration: string;
  status: PostingStatus;
  postedAt: string | null;
  postedBy: string | null;
  reversalOf: string | null;
  lines: JournalLine[];
}

/** What a stock posting produced: the event's journal (null if nothing had value) and any rounding sweep. */
export interface StockPosting {
  entry: JournalEntry | null;
  rounding: { entry: JournalEntry; movements: PostedMovement[] } | null;
}

// ---------------------------------------------------------------- journals

/** Read-only, for document screens: the journals that name this source document (id, number, status). */
export async function journalsOfSource(
  q: Queryable,
  companyId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ id: string; docNo: string; status: PostingStatus; event: PostingEvent | null }[]> {
  return (await repo.entriesOfSource(q, companyId, sourceType, sourceId)).map((e) => ({ id: e.id, docNo: e.docNo, status: e.status, event: e.event }));
}

/** Posts a system journal for a business event. The actor must hold the event's key (JournalPostingKeys). */
export async function postJournal(tx: Tx, actor: Actor, input: JournalInput): Promise<JournalEntry> {
  if (input.event === 'ROUNDING_DIFFERENCE') {
    throw new AppError('VALIDATION_FAILED', 'Rounding differences are posted only by the stock sweep (postStockJournal)');
  }
  return post(tx, actor, postingKey(input.event), input);
}

export interface ReverseInput {
  entryId: string;
  /** Date of the reversal (YYYY-MM-DD), in an OPEN period; may be later than the original. */
  date: string;
  reason: string;
}

/** Mirror entry (sides swapped, same accounts, dimensions and tax codes); the original becomes REVERSED (rule 4). */
export async function reverseJournal(tx: Tx, actor: Actor, input: ReverseInput): Promise<JournalEntry> {
  assertDate(input.date);
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError('VALIDATION_FAILED', 'Give the reason for the reversal (at least 3 characters)');
  const original = await repo.lockEntry(tx, actor.companyId, input.entryId);
  if (!original) throw new AppError('NOT_FOUND', `Journal entry ${input.entryId} not found`);
  if (original.status !== 'POSTED') {
    throw new AppError('INVALID_TRANSITION', `Journal ${original.docNo} is ${original.status}; only a POSTED entry is reversed`, {
      status: original.status,
    });
  }
  if (original.reversalOf) throw new AppError('VALIDATION_FAILED', `Journal ${original.docNo} is itself a reversal; post a new entry instead`);
  if (original.event === 'ROUNDING_DIFFERENCE') {
    throw new AppError('VALIDATION_FAILED', `Journal ${original.docNo} sweeps paisa off an empty lot; it is never reversed`);
  }
  if (original.event === null || original.sourceId === null) {
    throw new AppError('VALIDATION_FAILED', 'Manual journal vouchers are reversed from the journal voucher screen (M8)');
  }
  const key = postingKey(original.event);
  const map = journalMap(key);
  const lines = await repo.linesOf(tx, original.id);

  const reversal = await createDraft(tx, actor, map, {
    docNo: await nextDocNo(tx, SYSTEM_JOURNAL_SERIES, input.date),
    entryDate: input.date,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    event: original.event,
    narration: `Reversal of ${original.docNo}: ${reason}`,
    reversalOf: original.id,
  });
  await guarded(() =>
    repo.insertLines(
      tx,
      lines.map((l, i) => ({
        entryId: reversal.id,
        lineNo: i + 1,
        accountId: l.accountId,
        debit: l.credit,
        credit: l.debit,
        costCenterId: l.costCenterId,
        customerId: l.customerId,
        vendorId: l.vendorId,
        productionOrderId: l.productionOrderId,
        taxCodeId: l.taxCodeId,
        narration: l.narration,
      })),
    ),
  );
  await guarded(() => transition(tx, map, { entityId: reversal.id, to: 'POSTED', actor }));
  await guarded(() => transition(tx, map, { entityId: original.id, to: 'REVERSED', actor, reason, alsoSet: { reversal_id: reversal.id } }));
  return load(tx, reversal.id);
}

// ---------------------------------------------------------------- stock journals

export interface StockJournalInput {
  /** Rows just returned by engines/inventory for ONE document and ONE posting event, all on one date. */
  movements: readonly PostedMovement[];
  narration: string;
  /** Put on the lines opposite INVENTORY (e.g. the production order on WIP, the vendor on a debit note). */
  dimensions?: LineDimensions;
}

/**
 * The journal for stock movements (architecture §6): INVENTORY (by item category) against the event's other
 * account, one debit and one credit per movement value; customer-owned and zero-value rows post nothing
 * (rule 12). The source document and date come from the movements. Then the rounding sweep for their lots.
 */
export async function postStockJournal(tx: Tx, actor: Actor, input: StockJournalInput): Promise<StockPosting> {
  const { movements } = input;
  if (movements.length === 0) throw new AppError('VALIDATION_FAILED', 'Name the movements to post');
  for (const m of movements) {
    if (m.reversalOf) throw new AppError('VALIDATION_FAILED', 'Reversal movements are posted with reverseStockJournal()');
    if (m.movementType === 'TRANSFER_OUT' || m.movementType === 'TRANSFER_IN') {
      throw new AppError('VALIDATION_FAILED', 'Transfers move value between locations and post no journal');
    }
    if (m.movementType === 'ROUNDING_SWEEP') throw new AppError('VALIDATION_FAILED', 'Rounding sweeps are posted by the sweep itself');
    if (!movementPosting(m)) {
      throw new AppError('VALIDATION_FAILED', `No posting rule is defined for ${m.movementType} movements (architecture §6)`, {
        movementType: m.movementType,
      });
    }
  }
  const event = oneEvent(movements);
  const { doc, date } = oneDocumentAndDate(movements);
  const key = postingKey(event);
  const lines = stockLines(movements, input.dimensions);
  const entry = lines.length
    ? await post(tx, actor, key, { event, sourceType: doc.refDocType, sourceId: doc.refDocId, date, narration: input.narration, lines })
    : null;
  const rounding = await sweep(tx, actor, key, movements, doc, date);
  return { entry, rounding };
}

export interface ReverseStockInput {
  /** The stock journal being reversed; null when the original movements carried no value (no journal). */
  entryId: string | null;
  /** The reversal rows returned by engines/inventory reverseMovements(), all on one date. */
  movements: readonly PostedMovement[];
  reason: string;
}

/**
 * Reverses a stock journal together with its movements: the reversal rows must mirror movements of the journal's
 * source document and carry exactly its amount, so the GL keeps equal to the ledger. Then the rounding sweep
 * (a mirror can leave a few paisa on a lot it empties).
 */
export async function reverseStockJournal(tx: Tx, actor: Actor, input: ReverseStockInput): Promise<StockPosting> {
  const { movements } = input;
  if (movements.length === 0) throw new AppError('VALIDATION_FAILED', 'Name the reversal movements');
  for (const m of movements) {
    if (!m.reversalOf) throw new AppError('VALIDATION_FAILED', `Movement ${m.id} is not a reversal; post it with postStockJournal()`);
  }
  const event = oneEvent(movements);
  const { doc, date } = oneDocumentAndDate(movements);
  const key = postingKey(event);
  const valued = movements.filter(hasValue);
  const amount = valued.reduce((s, m) => s.plus(new Decimal(m.value).abs()), new Decimal(0));

  let entry: JournalEntry | null = null;
  if (input.entryId === null) {
    if (valued.length) {
      throw new AppError('VALIDATION_FAILED', 'These movements carry value; name the journal entry they were posted with');
    }
  } else {
    const original = await repo.findEntry(tx, actor.companyId, input.entryId);
    if (!original) throw new AppError('NOT_FOUND', `Journal entry ${input.entryId} not found`);
    const mismatch = (why: string) =>
      new AppError('VALIDATION_FAILED', `The reversed movements do not match journal ${original.docNo}: ${why}`, { entryId: original.id });
    if (original.event !== event) throw mismatch(`it posts ${original.event ?? 'a manual voucher'}, the movements are ${event}`);
    const sources = await movementDocuments(tx, actor.companyId, movements.map((m) => m.reversalOf!));
    for (const m of movements) {
      const src = sources.get(m.reversalOf!);
      if (!src || src.refDocType !== original.sourceType || src.refDocId !== original.sourceId) {
        throw mismatch(`movement ${m.reversalOf} belongs to another document`);
      }
    }
    const lines = await repo.linesOf(tx, original.id);
    const total = lines.reduce((s, l) => s.plus(l.debit), new Decimal(0));
    if (!total.equals(amount)) throw mismatch(`the journal carries ${total.toFixed(2)}, the movements ${amount.toFixed(2)}`);
    entry = await reverseJournal(tx, actor, { entryId: original.id, date, reason: input.reason });
  }
  const rounding = await sweep(tx, actor, key, movements, doc, date);
  return { entry, rounding };
}

// ---------------------------------------------------------------- internals

const hasValue = (m: PostedMovement) => !m.customerOwned && !new Decimal(m.value).isZero();

function oneEvent(movements: readonly PostedMovement[]): PostingEvent {
  const events = [...new Set(movements.map((m) => movementPosting(m)?.event))];
  const [event] = events;
  if (events.length !== 1 || !event) {
    throw new AppError('VALIDATION_FAILED', 'One journal posts one event; post these movements separately', { events });
  }
  return event;
}

function oneDocumentAndDate(movements: readonly PostedMovement[]): { doc: { refDocType: string; refDocId: string }; date: string } {
  const [first] = movements;
  if (!first) throw new AppError('VALIDATION_FAILED', 'Name the movements to post');
  for (const m of movements) {
    if (m.refDocType !== first.refDocType || m.refDocId !== first.refDocId) {
      throw new AppError('VALIDATION_FAILED', 'One journal posts the movements of one document');
    }
    if (m.movementDate !== first.movementDate) throw new AppError('VALIDATION_FAILED', 'One journal posts movements of one date');
  }
  return { doc: { refDocType: first.refDocType, refDocId: first.refDocId }, date: first.movementDate };
}

/** INVENTORY against the counter role, per item category and side; value > 0 debits INVENTORY. */
function stockLines(movements: readonly PostedMovement[], dims: LineDimensions = {}): JournalLineInput[] {
  const lines = new Map<string, { line: JournalLineInput; amount: Decimal }>();
  const add = (role: AccountRole, itemCategoryId: string, side: 'debit' | 'credit', amount: Decimal, d: LineDimensions) => {
    const key = `${role}|${itemCategoryId}|${side}`;
    const found = lines.get(key);
    if (found) found.amount = found.amount.plus(amount);
    else lines.set(key, { line: { role, itemCategoryId, ...d }, amount });
  };
  for (const m of movements) {
    if (!hasValue(m)) continue;
    const { counter } = movementPosting(m)!;
    const v = new Decimal(m.value);
    const into = v.gt(0);
    add('INVENTORY', m.itemCategoryId, into ? 'debit' : 'credit', v.abs(), {});
    add(counter, m.itemCategoryId, into ? 'credit' : 'debit', v.abs(), dims);
  }
  return [...lines.entries()].map(([key, { line, amount }]) =>
    key.endsWith('|debit') ? { ...line, debit: amount.toFixed(2) } : { ...line, credit: amount.toFixed(2) },
  );
}

/** Rounding sweep for every own-stock lot the movements touched (owner, 18-11-2026; 0016). */
async function sweep(
  tx: Tx,
  actor: Actor,
  key: PermissionKey,
  movements: readonly PostedMovement[],
  doc: { refDocType: string; refDocId: string },
  date: string,
): Promise<StockPosting['rounding']> {
  const lotIds = [...new Set(movements.filter((m) => !m.customerOwned).map((m) => m.lotId))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const swept: PostedMovement[] = [];
  for (const lotId of lotIds) {
    const row = await sweepEmptyLot(tx, actor, { lotId, date, ...doc });
    if (row) swept.push(row);
  }
  if (swept.length === 0) return null;
  const entry = await post(tx, actor, key, {
    event: 'ROUNDING_DIFFERENCE',
    sourceType: doc.refDocType,
    sourceId: doc.refDocId,
    date,
    narration: `Rounding difference left on empty lot ${swept.map((m) => m.lotNo).join(', ')}`,
    lines: stockLines(swept),
  });
  return { entry, movements: swept };
}

async function post(tx: Tx, actor: Actor, key: PermissionKey, input: JournalInput): Promise<JournalEntry> {
  assertDate(input.date);
  if (!/^[A-Z][A-Z_]{1,29}$/.test(input.sourceType) || input.sourceType === 'MANUAL' || !/^[1-9]\d{0,18}$/.test(input.sourceId)) {
    throw new AppError('VALIDATION_FAILED', 'A system journal names its source document (type in capitals, not MANUAL, and id)');
  }
  const narration = input.narration?.trim() ?? '';
  if (narration.length === 0 || narration.length > 500) throw new AppError('VALIDATION_FAILED', 'Narration: 1 to 500 characters');
  if (input.lines.length < 2) throw new AppError('JOURNAL_UNBALANCED', 'A journal has at least two lines');

  const roles = PostingEventRoles[input.event];
  let debits = new Decimal(0);
  let credits = new Decimal(0);
  const amounts = input.lines.map((l, i) => {
    if (!roles.includes(l.role)) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: ${input.event} does not use account role ${l.role}`, { roles });
    }
    const debit = money(l.debit ?? '0', i);
    const credit = money(l.credit ?? '0', i);
    if (debit.isZero() === credit.isZero()) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: give a debit or a credit greater than zero, not both`);
    }
    debits = debits.plus(debit);
    credits = credits.plus(credit);
    return { debit: debit.toFixed(2), credit: credit.toFixed(2) };
  });
  if (!debits.equals(credits)) {
    throw new AppError('JOURNAL_UNBALANCED', `Debits ${debits.toFixed(2)} and credits ${credits.toFixed(2)} differ`, {
      debits: debits.toFixed(2),
      credits: credits.toFixed(2),
    });
  }
  for (const taxCodeId of new Set(input.lines.flatMap((l) => (l.taxCodeId ? [l.taxCodeId] : [])))) {
    await assertTaxRateConfirmed(tx, actor.companyId, taxCodeId);
  }
  const accountIds: string[] = [];
  for (const l of input.lines) {
    const accountId = await repo.ruleAccount(tx, actor.companyId, input.event, l.role, l.itemCategoryId ?? null);
    if (!accountId) {
      throw new AppError('POSTING_RULE_MISSING', `No active posting rule gives the ${l.role} account for ${input.event}`, {
        event: input.event,
        role: l.role,
        itemCategoryId: l.itemCategoryId ?? null,
      });
    }
    accountIds.push(accountId);
  }

  const map = journalMap(key);
  const entry = await createDraft(tx, actor, map, {
    docNo: await nextDocNo(tx, SYSTEM_JOURNAL_SERIES, input.date),
    entryDate: input.date,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    event: input.event,
    narration,
    reversalOf: null,
  });
  await guarded(() =>
    repo.insertLines(
      tx,
      input.lines.map((l, i) => ({
        entryId: entry.id,
        lineNo: i + 1,
        accountId: accountIds[i]!,
        debit: amounts[i]!.debit,
        credit: amounts[i]!.credit,
        costCenterId: l.costCenterId ?? null,
        customerId: l.customerId ?? null,
        vendorId: l.vendorId ?? null,
        productionOrderId: l.productionOrderId ?? null,
        taxCodeId: l.taxCodeId ?? null,
        narration: l.narration ?? null,
      })),
    ),
  );
  await guarded(() => transition(tx, map, { entityId: entry.id, to: 'POSTED', actor }));
  return load(tx, entry.id);
}

async function createDraft(
  tx: Tx,
  actor: Actor,
  map: TransitionMap<PostingStatus>,
  v: { docNo: string; entryDate: string; sourceType: string; sourceId: string; event: PostingEvent; narration: string; reversalOf: string | null },
): Promise<repo.EntryRow> {
  // Permission first, so nothing is written for an actor without the key.
  const move = map.moves.find((m) => m.from === null)!;
  if (move.permission !== 'SYSTEM' && !actor.permissions.has(move.permission)) {
    throw new AppError('FORBIDDEN', `Posting this journal needs ${move.permission}`, { permission: move.permission });
  }
  const entry = await guarded(() => repo.insertEntry(tx, { ...v, status: 'DRAFT' }));
  await recordInitialStatus(tx, map, { entityId: entry.id, to: 'DRAFT', actor });
  return entry;
}

async function load(tx: Tx, id: string): Promise<JournalEntry> {
  const e = await repo.reloadEntry(tx, id);
  const lines = await repo.linesOf(tx, id);
  return {
    id: e.id,
    docNo: e.docNo,
    entryDate: e.entryDate,
    periodId: e.periodId,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    event: e.event,
    narration: e.narration,
    status: e.status,
    postedAt: e.postedAt ? e.postedAt.toISOString() : null,
    postedBy: e.postedBy,
    reversalOf: e.reversalOf,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      costCenterId: l.costCenterId,
      customerId: l.customerId,
      vendorId: l.vendorId,
      productionOrderId: l.productionOrderId,
      taxCodeId: l.taxCodeId,
      narration: l.narration,
    })),
  };
}

function money(v: string, i: number): Decimal {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(v)) {
    throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: amounts are ≥ 0 with at most 2 decimals (got "${v}")`);
  }
  return new Decimal(v);
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new AppError('VALIDATION_FAILED', `Date must be YYYY-MM-DD (got "${date}")`);
  }
}

/** Turns a database guard error into the AppError it names. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw fromDbError(err) ?? err;
  }
}
