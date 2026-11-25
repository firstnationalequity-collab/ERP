// GRN labels (architecture §2 "Documents" pdfmake, "Barcodes" bwip-js; build-plan M3 task 3): one 100 × 70 mm
// label per container of each line of a POSTED GRN, with the lot number as a Code128 barcode (scanners read it as
// keyboard input). The label shows QUARANTINE: the status the lot had when received; QC/QA status labels follow
// in M4/M7. Route key: inv.label.print.
import bwipjs from 'bwip-js/node';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { AppError } from '../../core/errors';
import type { AuthContext } from '../../core/auth/auth.service';
import { getGrn } from './grns.service';

// The 14 standard PDF fonts need no font files on the server.
pdfmake.setFonts({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } });

const MM = 72 / 25.4;
const ddmmyyyy = (d: string | null) => (d ? d.split('-').reverse().join('-') : '—');

async function code128(text: string): Promise<string> {
  const png = await bwipjs.toBuffer({ bcid: 'code128', text, scale: 3, height: 10, includetext: false });
  return `data:image/png;base64,${png.toString('base64')}`;
}

const row = (label: string, value: string): Content => ({
  columns: [
    { text: label, width: 62, color: '#444444' },
    { text: value, bold: true },
  ],
  columnGap: 4,
  margin: [0, 0.5, 0, 0.5],
});

export async function grnLabelsPdf(auth: AuthContext, grnId: string): Promise<{ fileName: string; pdf: Buffer }> {
  const grn = await getGrn(auth, grnId);
  if (grn.status !== 'POSTED') {
    throw new AppError('INVALID_TRANSITION', `GRN ${grn.docNo} is ${grn.status}; labels are printed once it is posted (the lots exist then)`);
  }
  const pages: Content[] = [];
  for (const l of grn.lines) {
    if (!l.lotNo) continue;
    const barcode = await code128(l.lotNo);
    for (let n = 1; n <= l.containers; n++) {
      pages.push({
        stack: [
          {
            columns: [
              { text: 'Albert Pharmaceuticals', bold: true, fontSize: 9 },
              { text: 'QUARANTINE', bold: true, fontSize: 13, alignment: 'right', color: '#b45309' },
            ],
          },
          { text: `${l.itemCode} — ${l.itemName}`, bold: true, fontSize: 10, margin: [0, 3, 0, 2] },
          { image: barcode, width: 70 * MM, height: 11 * MM, alignment: 'center' },
          { text: l.lotNo, alignment: 'center', bold: true, fontSize: 11, margin: [0, 1, 0, 3] },
          row('Mfr batch', l.mfrBatchNo ?? '—'),
          row('Manufacturer', [l.manufacturer, l.manufacturingSite].filter(Boolean).join(', ') || '—'),
          row('GRN', `${grn.docNo} · ${ddmmyyyy(grn.grnDate)}`),
          row('Mfg / Expiry', `${ddmmyyyy(l.mfgDate)} / ${ddmmyyyy(l.expiryDate)}`),
          row('Retest', ddmmyyyy(l.retestDate)),
          row('Quantity', `${l.qty} ${l.uomCode} (line total) · container ${n} of ${l.containers}`),
        ],
        pageBreak: pages.length > 0 ? 'before' : undefined,
      });
    }
  }
  const doc: TDocumentDefinitions = {
    pageSize: { width: 100 * MM, height: 70 * MM },
    pageMargins: [4 * MM, 3 * MM, 4 * MM, 3 * MM],
    defaultStyle: { font: 'Helvetica', fontSize: 7.5 },
    info: { title: `Labels ${grn.docNo}`, creator: 'Albert ERP' },
    content: pages,
  };
  const pdf = await pdfmake.createPdf(doc).getBuffer();
  return { fileName: `labels-${grn.docNo}.pdf`, pdf };
}
