// Certificates of analysis (architecture §2 Documents, §7.6 "CoA print"; build-plan M4 task 4; 0039, 0040).
//
// A holder of qc.coa.issue (QC Manager) issues one certificate per QC approval of a material lot: the lot is APPROVED
// now and the approval is its latest disposition. The issuer signs (e-signature APPROVED on the disposition), the
// number comes from series COA ({PREFIX}-{FY}-{SEQ:5}), and the PDF (pdfmake) is stored in the same transaction as an
// attachment of the certificate with its SHA-256 (re-checked on every download: FILE_INTEGRITY_FAILED). The PDF
// reports the company header (settings company.*), the pinned spec, the latest result of each test (re-tests marked
// with the OOS investigation that invalidated the original, number and outcome), analysts, reviewers and the approval.
// Correction (owner 2026-11-27; 0040): re-issue = a new version of the same number, e-signed (APPROVED) on the version
// it supersedes with the reason; the previous version is SUPERSEDED (read from the newer one) and still downloadable.
// Finished-goods certificates follow QA release (M7; owner 2026-11-27: QC never approves an FG lot).
import { createHash } from 'node:crypto';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { Decimal } from 'decimal.js';
import type { CoaCandidateDto, CoaDto, CoaListQuery, IssueCoaRequest, Page, ReissueCoaRequest } from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { recordSignature, verifySignature, type SignatureRecord } from '../../core/esign/esign.service';
import { userNames } from '../../core/access/access.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { companyHeader } from '../../core/settings/company.settings';
import { attachmentIdsOf, download, registerAttachmentTarget, storeGeneratedFile } from '../../core/attachments/attachments.service';
import { getLot, lockLotForDecision, lotIdsByStatus, lotIdsMatching, lotIdsOfItems, lotsByIds, type Lot } from '../../engines/inventory';
import { qcItemIdsMatching, qcItems } from '../masters/qc-refs.service';
import { latestPerTest } from './samples.service';
import { limitText } from './spec-text';
import { oosByResult } from './oos.service';
import * as specsRepo from './specs.repo';
import * as samplesRepo from './sample-requests.repo';
import * as dispositionsRepo from './dispositions.repo';
import * as repo from './coas.repo';

export const COA_TABLE = 'qc.coas';
const ISSUE_KEY = 'qc.coa.issue';
const DISPOSITION_TABLE = 'qc.dispositions';

registerAttachmentTarget(COA_TABLE, {
  readPermission: 'qc.view',
  writePermission: ISSUE_KEY,
  gmp: true, // a QC record: voiding its PDF needs the QA Manager countersign (0025); no other file is accepted (0039)
  exists: (q, recordId) => repo.coaExists(q, recordId),
});

pdfmake.setFonts({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } });

const ddmmyyyy = (d: string | null) => (d ? d.split('-').reverse().join('-') : '—');
/** DD-MM-YYYY HH:mm in Asia/Karachi (CLAUDE.md conventions). */
function karachi(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} PKT`;
}
const num = (v: string) => new Decimal(v).toString();

// ---------------------------------------------------------------- what may be certified

interface Certifiable {
  lot: Lot;
  disposition: dispositionsRepo.DispositionRow;
}

const lotDetails = (lot: Lot) => ({ lotId: lot.id, lotNo: lot.lotNo, status: lot.status });

/** The lot's latest disposition (with every disposition of the lot, in order). */
async function latestDisposition(q: Queryable, companyId: string, lot: Lot): Promise<dispositionsRepo.DispositionRow | undefined> {
  const all = await dispositionsRepo.dispositionsOfLots(q, companyId, [lot.id]);
  return all[all.length - 1];
}

/** The lot's latest disposition, if it is an approval of an APPROVED material lot; else why not. */
async function certifiable(q: Queryable, companyId: string, lot: Lot): Promise<Certifiable> {
  const details = lotDetails(lot);
  const item = (await qcItems(q, companyId, [lot.itemId])).get(lot.itemId);
  if (item?.type === 'FG') throw new AppError('FG_LOT_QA_DECIDES', `Lot ${lot.lotNo} is a finished-goods lot: its certificate follows QA release`, details);
  if (lot.status !== 'APPROVED') throw new AppError('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is ${lot.status}; a certificate is issued for an APPROVED lot`, details);
  const latest = await latestDisposition(q, companyId, lot);
  if (!latest || latest.decision !== 'APPROVED' || latest.sampleRequestId === null) {
    throw new AppError('LOT_NOT_APPROVED', `Lot ${lot.lotNo} has no QC approval to certify`, details);
  }
  const [issued] = await repo.coasOfDispositions(q, companyId, [latest.id]);
  if (issued) throw new AppError('ALREADY_EXISTS', `Certificate ${issued.docNo} was already issued for this approval; download it again or re-issue it`, { ...details, coaId: issued.id });
  return { lot, disposition: latest };
}

/** A re-issue: the certificate is its number's current version and still reports the lot's latest disposition. */
async function reissuable(q: Queryable, companyId: string, coa: repo.CoaRow, lot: Lot): Promise<Certifiable> {
  const [next] = await repo.successorsOf(q, [coa.id]);
  if (next) {
    throw new AppError('INVALID_TRANSITION', `Version ${coa.version} of ${coa.docNo} is superseded; re-issue the current version`, { coaId: coa.id, currentId: next.id });
  }
  const latest = await latestDisposition(q, companyId, lot);
  if (!latest || latest.id !== coa.dispositionId) {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} was decided again after ${coa.docNo}; that certificate is not re-issued`, lotDetails(lot));
  }
  return { lot, disposition: latest };
}

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.CoaRow[]): Promise<CoaDto[]> {
  const lots = await lotsByIds(q, companyId, rows.map((r) => r.lotId));
  const items = await qcItems(q, companyId, [...lots.values()].map((l) => l.itemId));
  const names = await userNames(q, [...new Set(rows.map((r) => r.issuedBy))]);
  const files = await attachmentIdsOf(q, companyId, COA_TABLE, rows.map((r) => r.id));
  const successors = new Map((await repo.successorsOf(q, rows.map((r) => r.id))).map((s) => [s.supersedesId, s.id]));
  return rows.map((r) => {
    const lot = lots.get(r.lotId);
    const item = lot ? items.get(lot.itemId) : undefined;
    const supersededById = successors.get(r.id) ?? null;
    return {
      id: r.id,
      docNo: r.docNo,
      version: r.version,
      status: supersededById ? 'SUPERSEDED' : 'CURRENT',
      supersedesId: r.supersedesId,
      supersededById,
      reissueReason: r.reissueReason,
      lotId: r.lotId,
      lotNo: lot?.lotNo ?? '',
      itemCode: item?.code ?? '',
      itemName: item?.name ?? '',
      dispositionId: r.dispositionId,
      sampleRequestId: r.sampleRequestId,
      fileName: r.fileName,
      sha256: r.sha256,
      attachmentId: files.get(r.id) ?? null,
      issuedBy: r.issuedBy,
      issuedByName: names.get(r.issuedBy) ?? r.issuedBy,
      issuedAt: r.issuedAt.toISOString(),
    };
  });
}

export async function listCoas(auth: AuthContext, query: CoaListQuery): Promise<Page<CoaDto>> {
  let filter: { docNo?: string; lotIds?: string[] } = {};
  if (query.search) {
    const lotIds = [
      ...new Set([
        ...(await lotIdsMatching(db, auth.companyId, query.search)),
        ...(await lotIdsOfItems(db, auth.companyId, await qcItemIdsMatching(db, auth.companyId, query.search))),
      ]),
    ];
    filter = { docNo: query.search, lotIds };
  }
  const where = repo.coaWhere(auth.companyId, filter);
  const rows = await repo.listCoas(db, where, { offset: (query.page - 1) * query.pageSize, limit: query.pageSize });
  return { items: await toDtos(db, auth.companyId, rows), total: await repo.countCoas(db, where), page: query.page, pageSize: query.pageSize };
}

export async function getCoa(auth: AuthContext, id: string): Promise<CoaDto> {
  const row = await repo.findCoa(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Certificate of analysis not found');
  return (await toDtos(db, auth.companyId, [row]))[0]!;
}

/** APPROVED material lots whose current QC approval has no certificate yet (newest approval first). */
export async function listCoaCandidates(auth: AuthContext): Promise<CoaCandidateDto[]> {
  const lots = [...(await lotsByIds(db, auth.companyId, await lotIdsByStatus(db, auth.companyId, ['APPROVED'], 2000))).values()];
  const items = await qcItems(db, auth.companyId, lots.map((l) => l.itemId));
  const material = lots.filter((l) => items.get(l.itemId)?.type !== 'FG');
  const all = await dispositionsRepo.dispositionsOfLots(db, auth.companyId, material.map((l) => l.id));
  const latest = new Map<string, dispositionsRepo.DispositionRow>();
  for (const d of all) latest.set(d.lotId, d); // ordered by id
  const approvals = [...latest.values()].filter((d) => d.decision === 'APPROVED' && d.sampleRequestId !== null);
  const issued = new Set((await repo.coasOfDispositions(db, auth.companyId, approvals.map((d) => d.id))).map((c) => c.dispositionId));
  const open = approvals.filter((d) => !issued.has(d.id)).sort((x, y) => (BigInt(x.id) > BigInt(y.id) ? -1 : 1));
  const names = await userNames(db, [...new Set(open.map((d) => d.decidedBy))]);
  const byId = new Map(material.map((l) => [l.id, l]));
  return open.map((d) => {
    const lot = byId.get(d.lotId)!;
    const item = items.get(lot.itemId);
    return {
      lotId: lot.id,
      lotNo: lot.lotNo,
      itemCode: item?.code ?? '',
      itemName: item?.name ?? '',
      dispositionId: d.id,
      approvedAt: d.decidedAt.toISOString(),
      approvedByName: names.get(d.decidedBy) ?? d.decidedBy,
    };
  });
}

/** The stored PDF of any version, refused if it no longer matches its SHA-256 (FILE_INTEGRITY_FAILED). */
export async function coaPdf(auth: AuthContext, id: string): Promise<{ fileName: string; pdf: Buffer }> {
  const coa = await getCoa(auth, id);
  if (!coa.attachmentId) throw new AppError('FILE_INTEGRITY_FAILED', `The PDF of certificate ${coa.docNo} is missing`);
  const { bytes } = await download(auth, coa.attachmentId);
  return { fileName: coa.fileName, pdf: bytes };
}

// ---------------------------------------------------------------- the PDF

interface VersionInfo {
  version: number;
  /** For a re-issue: the version it supersedes and why. */
  supersedes: repo.CoaRow | null;
  reason: string | null;
}

async function buildPdf(tx: Tx, auth: AuthContext, c: Certifiable, docNo: string, v: VersionInfo, issuedAt: Date, issuerName: string): Promise<Buffer> {
  const { lot, disposition } = c;
  const company = await companyHeader(tx, auth.companyId);
  const item = (await qcItems(tx, auth.companyId, [lot.itemId])).get(lot.itemId);
  const request = (await samplesRepo.findRequest(tx, auth.companyId, disposition.sampleRequestId!))!;
  const spec = (await specsRepo.specsByIds(tx, auth.companyId, [request.specId!]))[0]!;
  const tests = await specsRepo.specTestsOf(tx, spec.id);
  const results = await samplesRepo.resultsOf(tx, [request.id]);
  const latest = latestPerTest(results);
  const oos = await oosByResult(tx, results.map((r) => r.id));
  const people = [...new Set([request.sampledBy, disposition.decidedBy, ...results.flatMap((r) => [r.enteredBy, r.reviewedBy])].filter((x): x is string => x !== null))];
  const names = await userNames(tx, people);
  const who = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => x !== null))].map((u) => names.get(u) ?? u).join(', ') || '—';

  /** OOS investigations of a test's results (owner 2026-11-27: printed next to a re-tested test). */
  const oosOfTest = (testId: string) =>
    results.filter((r) => r.specTestId === testId && oos.has(r.id)).map((r) => {
      const o = oos.get(r.id)!;
      return `${o.docNo} ${o.outcome ?? 'OPEN'}${o.causeCategory ? ` (${o.causeCategory})` : ''}`;
    });

  const field = (label: string, value: string): Content[] => [{ text: label, color: '#444444' }, { text: value, bold: true }];
  const rows = tests.map((t) => {
    const r = latest.get(t.id);
    const value = !r ? '—' : r.resultType === 'NUMERIC' ? `${num(r.numericValue!)}${t.unit ? ` ${t.unit}` : ''}` : (r.textValue ?? '');
    const investigations = r?.retestOf ? oosOfTest(t.id) : [];
    const note = r?.retestOf ? `\n(re-test${investigations.length > 0 ? `; ${investigations.join('; ')}` : ''})` : '';
    return [
      { text: t.name + (t.method ? `\n${t.method}` : ''), fontSize: 8 },
      { text: limitText(t), fontSize: 8 },
      { text: value + note, fontSize: 8 },
      { text: !r ? '—' : r.passed ? 'Complies' : 'Does not comply', fontSize: 8, bold: true },
    ];
  });
  const retests = results.filter((r) => r.retestOf !== null);
  const retestNote = (r: samplesRepo.ResultWithReview) => {
    const o = r.retestOf ? oos.get(r.retestOf) : undefined;
    const name = tests.find((t) => t.id === r.specTestId)?.name ?? r.specTestId;
    return `${name} — ${r.retestReason}${o ? ` [${o.docNo} ${o.outcome ?? 'OPEN'}${o.causeCategory ? `, ${o.causeCategory}` : ''}]` : ''}`;
  };
  const header: Content = {
    columns: [
      ...(company.logo ? [{ image: company.logo, fit: [70, 45] as [number, number], width: 80 }] : []),
      {
        stack: [
          { text: company.name, bold: true, fontSize: 12 },
          { text: company.address, fontSize: 8 },
          { text: `DRAP licence: ${company.drapLicenceNo}`, fontSize: 8 },
        ],
      },
      { stack: [{ text: docNo, bold: true, fontSize: 12 }, { text: `Version ${v.version}`, fontSize: 8 }], alignment: 'right', width: 130 },
    ],
  };
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    info: { title: `Certificate of analysis ${docNo} v${v.version}`, creator: 'Albert ERP' },
    footer: (page, pages) => ({
      text: `${docNo} version ${v.version} · page ${page} of ${pages} · electronically signed records; issued by Albert ERP`,
      alignment: 'center',
      fontSize: 7,
      color: '#666666',
    }),
    content: [
      header,
      { text: 'CERTIFICATE OF ANALYSIS', alignment: 'center', bold: true, fontSize: 15, margin: [0, 10, 0, 4] },
      ...(v.supersedes
        ? [{
            text: `Version ${v.version} supersedes version ${v.supersedes.version} issued ${karachi(v.supersedes.issuedAt)}. Reason: ${v.reason}`,
            alignment: 'center', fontSize: 8, bold: true, margin: [0, 0, 0, 6],
          } as Content]
        : []),
      {
        table: {
          widths: [90, '*', 90, '*'],
          body: [
            [...field('Item', `${item?.code ?? ''} — ${item?.name ?? ''}`), ...field('Item type', item?.type ?? '')],
            [...field('Lot number', lot.lotNo), ...field('Mfr batch', lot.mfrBatchNo ?? '—')],
            [...field('Manufacturer', lot.manufacturer ?? '—'), ...field('Mfg date', ddmmyyyy(lot.mfgDate))],
            [...field('Expiry date', ddmmyyyy(lot.expiryDate)), ...field('Retest date', ddmmyyyy(lot.retestDate))],
            [...field('Specification', `version ${spec.version}`), ...field('Sample request', `${request.id} · sampled ${request.sampledAt ? karachi(request.sampledAt) : '—'}`)],
          ],
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 10],
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', 110, 130, 70],
          body: [
            [{ text: 'Test', bold: true }, { text: 'Limit', bold: true }, { text: 'Result', bold: true }, { text: 'Conclusion', bold: true }],
            ...rows,
          ],
        },
        layout: 'lightHorizontalLines',
      },
      ...(retests.length > 0 ? [{ text: `Re-tests: ${retests.map(retestNote).join('; ')}`, fontSize: 8, margin: [0, 6, 0, 0] } as Content] : []),
      {
        text: `Conclusion: the lot complies with specification version ${spec.version}. QC disposition: APPROVED.`,
        bold: true,
        margin: [0, 12, 0, 8],
      },
      {
        table: {
          widths: [110, '*'],
          body: [
            field('Sampled by', who([request.sampledBy])),
            field('Analysed by', who(results.map((r) => r.enteredBy))),
            field('Reviewed by', who(results.map((r) => r.reviewedBy))),
            field('Approved by', `${who([disposition.decidedBy])} · ${karachi(disposition.decidedAt)} · e-signature APPROVED: ${disposition.reason}`),
            field(v.supersedes ? 'Re-issued by' : 'Certificate issued by', `${issuerName} · ${karachi(issuedAt)} · e-signature APPROVED`),
          ],
        },
        layout: 'noBorders',
      },
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}

/** In the issuing transaction: render, store the certificate row and its PDF. */
async function store(tx: Tx, auth: AuthContext, c: Certifiable, docNo: string, v: VersionInfo, sig: SignatureRecord): Promise<string> {
  const issuer = (await userNames(tx, [auth.userId])).get(auth.userId) ?? auth.userId;
  const pdf = await buildPdf(tx, auth, c, docNo, v, new Date(), issuer);
  const fileName = v.version === 1 ? `${docNo}.pdf` : `${docNo}-v${v.version}.pdf`;
  const coa = await repo.insertCoa(tx, {
    docNo,
    lotId: c.lot.id,
    dispositionId: c.disposition.id,
    sampleRequestId: c.disposition.sampleRequestId!,
    fileName,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    esignId: sig.id,
    version: v.version,
    supersedesId: v.supersedes?.id ?? null,
    reissueReason: v.reason,
  });
  const what = v.version === 1 ? '' : ` version ${v.version}`;
  await storeGeneratedFile(tx, { recordTable: COA_TABLE, recordId: coa.id, fileName, contentType: 'application/pdf', bytes: pdf, description: `Certificate of analysis ${docNo}${what}, lot ${c.lot.lotNo}` });
  return coa.id;
}

// ---------------------------------------------------------------- issuing

function assertIssuer(auth: AuthContext, meaning: string): void {
  if (meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'A certificate of analysis is signed with the meaning APPROVED');
  if (!auth.permissions.has(ISSUE_KEY)) throw new AppError('FORBIDDEN', 'You do not have permission to issue certificates of analysis', { permission: ISSUE_KEY });
}

export async function issueCoa(auth: AuthContext, input: IssueCoaRequest, meta: RequestMeta): Promise<CoaDto> {
  assertIssuer(auth, input.signature.meaning);
  // Refuse before asking for the password, then again under lock.
  await certifiable(db, auth.companyId, await getLot(db, auth.companyId, input.lotId));
  const proof = await verifySignature(auth, input.signature, meta);
  const id = await withTransaction(txContext(auth, `issue certificate of analysis for lot ${input.lotId}: ${input.signature.reason}`), async (tx) => {
    const c = await certifiable(tx, auth.companyId, await lockLotForDecision(tx, auth.companyId, input.lotId));
    const docNo = await nextDocNo(tx, 'COA');
    const sig = await recordSignature(tx, proof, { table: DISPOSITION_TABLE, id: c.disposition.id }, ['APPROVED']);
    return store(tx, auth, c, docNo, { version: 1, supersedes: null, reason: null }, sig);
  });
  return getCoa(auth, id);
}

/**
 * Correct a certificate (owner 2026-11-27): a new version of the same number, rendered from the current records,
 * signed on the version it supersedes; the signature's reason is the re-issue reason. The old version is kept.
 */
export async function reissueCoa(auth: AuthContext, id: string, input: ReissueCoaRequest, meta: RequestMeta): Promise<CoaDto> {
  assertIssuer(auth, input.signature.meaning);
  const check = async (q: Queryable, lot: (lotId: string) => Promise<Lot>, lock: boolean) => {
    const coa = await repo.findCoa(q, auth.companyId, id, lock);
    if (!coa) throw new AppError('NOT_FOUND', 'Certificate of analysis not found');
    return { coa, c: await reissuable(q, auth.companyId, coa, await lot(coa.lotId)) };
  };
  await check(db, (lotId) => getLot(db, auth.companyId, lotId), false);
  const proof = await verifySignature(auth, input.signature, meta);
  const newId = await withTransaction(txContext(auth, `re-issue certificate of analysis ${id}: ${input.signature.reason}`), async (tx) => {
    const { coa, c } = await check(tx, (lotId) => lockLotForDecision(tx, auth.companyId, lotId), true);
    const sig = await recordSignature(tx, proof, { table: COA_TABLE, id: coa.id }, ['APPROVED']);
    return store(tx, auth, c, coa.docNo, { version: coa.version + 1, supersedes: coa, reason: sig.reason }, sig);
  });
  return getCoa(auth, newId);
}
