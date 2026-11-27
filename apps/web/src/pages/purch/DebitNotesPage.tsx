// Debit notes against a POSTED goods vendor invoice (M3 task 5b, 0032). The Accountant drafts a note (price claim:
// an amount per line; short supply: the quantity billed beyond what was received; return to vendor: a quantity of the
// line's REJECTED lot), submits it to the approval matrix (DEBIT_NOTE; whoever drafted or submitted it cannot
// approve), then posts it. A return note is posted by the Warehouse Manager with a QA witness e-signature (rule 1):
// the lot leaves the location and is RETURNED when empty. The note reduces what is open on the invoice.
// A Finance Manager reverses a posted note with an e-signature (owner 2026-11-27); reversing a return puts the stock
// back into the lot (QA witness at the same terminal) and is refused once the lot is RETURNED.
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, InputNumber, Modal, Radio, Space, Table, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateDebitNoteRequest,
  DebitNoteReason,
  DebitNoteStatus,
  UpdateDebitNoteRequest,
  type DebitableDto,
  type DebitableLineDto,
  type DebitNoteDto,
  type DebitNoteLineDto,
} from '@albert/shared';
import { api, errorText, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { ESignModal } from '../../components/ESignModal';
import { ReasonModal } from '../../components/ReasonModal';
import { RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDecimal, toBusinessDate } from '../../lib/format';

export const debitNotesKey = ['purch', 'debit-notes'];

const REASON_LABEL: Record<DebitNoteReason, string> = {
  PRICE_CLAIM: 'Price claim',
  SHORT_SUPPLY: 'Short supply',
  RETURN_TO_VENDOR: 'Return to vendor',
};

export function DebitNotesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Debit notes">
        Claims against a posted goods invoice: a price claim, a short supply (billed more than received) or the return of a lot QC rejected. A Finance Manager approves (never
        the person who drafted it); a return is posted by the Warehouse Manager with a QA witness.
      </PageHeader>
      <DataTable<DebitNoteDto>
        title="Debit notes"
        path="/purch/debit-notes"
        queryKey={debitNotesKey}
        filters={[statusFilter(DebitNoteStatus)]}
        searchPlaceholder="Search number or invoice"
        onRowClick={(r) => setOpenId(r.id)}
        toolbar={can('fin.debit_note.manage') && <Button type="primary" onClick={() => setAdding(true)}>Draft debit note</Button>}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'reason', title: 'Reason', render: (r) => REASON_LABEL[r.reason], exportValue: (r) => r.reason },
          { key: 'vendorName', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => r.vendorCode },
          { key: 'invoiceDocNo', title: 'Invoice', render: (r) => `${r.invoiceDocNo} · ${r.vendorInvoiceNo}`, exportValue: (r) => r.invoiceDocNo },
          { key: 'dnDate', title: 'Date', render: (r) => formatDate(r.dnDate), exportValue: (r) => formatDate(r.dnDate) },
          { key: 'totalAmount', title: 'Total', render: (r) => `${r.currency} ${formatDecimal(r.totalAmount)}`, exportValue: (r) => r.totalAmount, exportFormat: 'money' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {adding && (
        <NoteEditor
          note={null}
          onClose={() => setAdding(false)}
          onSaved={async (id) => {
            await qc.invalidateQueries({ queryKey: debitNotesKey });
            setOpenId(id);
          }}
        />
      )}
      {openId && <NoteDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: debitNotesKey })} />}
    </>
  );
}

function NoteEditor({ note, onClose, onSaved }: { note: DebitNoteDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const [invoiceId, setInvoiceId] = useState<string | undefined>(note?.invoiceId);
  const [reason, setReason] = useState<DebitNoteReason>(note?.reason ?? 'PRICE_CLAIM');
  const [head, setHead] = useState({ dnDate: note?.dnDate ?? companyToday(), notes: note?.notes ?? '' });
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((note?.lines ?? []).map((l) => [l.invoiceLineId, (note?.reason === 'PRICE_CLAIM' ? l.amount : l.qty) ?? ''])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debitable = useQuery({
    queryKey: [...debitNotesKey, 'debitable', invoiceId],
    enabled: !!invoiceId,
    queryFn: () => api<DebitableDto>(`/purch/vendor-invoices/${invoiceId}/debitable`),
  });
  const byAmount = reason === 'PRICE_CLAIM';
  const openFor = (l: DebitableLineDto) =>
    reason === 'PRICE_CLAIM' ? `${formatDecimal(l.amountOpen)}` : reason === 'SHORT_SUPPLY' ? `${formatDecimal(l.shortQtyOpen, 4)} qty` : `${formatDecimal(l.returnQtyOpen, 4)} qty`;

  const save = async () => {
    const lines = Object.entries(values)
      .filter(([, v]) => v)
      .map(([invoiceLineId, v]) => (byAmount ? { invoiceLineId, amount: v } : { invoiceLineId, qty: v }));
    const body = { dnDate: head.dnDate, notes: head.notes || null, lines };
    const parsed = note ? UpdateDebitNoteRequest.safeParse(body) : CreateDebitNoteRequest.safeParse({ ...body, invoiceId, reason });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => i.message).join('; '));
    setBusy(true);
    try {
      const saved = await api<DebitNoteDto>(note ? `/purch/debit-notes/${note.id}` : '/purch/debit-notes', { method: note ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open width={960} title={note ? `Edit ${note.docNo}` : 'Draft a debit note'} okText="Save draft" confirmLoading={busy} onOk={save} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} />}
        {!note && (
          <>
            <RefSelect
              path="/purch/vendor-invoices"
              params={{ status: 'POSTED' }}
              aria-label="Vendor invoice"
              placeholder="Posted goods invoice"
              value={invoiceId}
              onChange={(v) => { setInvoiceId(v); setValues({}); }}
            />
            <Radio.Group value={reason} onChange={(e) => { setReason(e.target.value as DebitNoteReason); setValues({}); }}>
              {DebitNoteReason.map((r) => <Radio.Button key={r} value={r}>{REASON_LABEL[r]}</Radio.Button>)}
            </Radio.Group>
          </>
        )}
        <Space wrap>
          <DatePicker aria-label="Debit note date" format="DD-MM-YYYY" value={dayjs(head.dnDate)} onChange={(d) => d && setHead({ ...head, dnDate: toBusinessDate(d) })} />
          <Input aria-label="Notes" placeholder="Notes (what was agreed with the vendor)" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} style={{ width: 420 }} />
        </Space>
        {debitable.data && (
          <Typography.Text type="secondary">
            Open on {debitable.data.docNo}: {debitable.data.currency} {formatDecimal(debitable.data.openAmount)}
            {reason === 'RETURN_TO_VENDOR' && ' · a return note takes one line, of a lot QC has REJECTED'}
          </Typography.Text>
        )}
        <Table<DebitableLineDto>
          rowKey="invoiceLineId"
          size="small"
          pagination={false}
          loading={debitable.isFetching}
          dataSource={debitable.data?.lines ?? []}
          locale={{ emptyText: invoiceId ? 'Nothing on this invoice can be debited' : 'Pick the invoice' }}
          columns={[
            { title: '#', dataIndex: 'lineNo', width: 40 },
            { title: 'Item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
            { title: 'GRN · lot', render: (_, l) => `${l.grnDocNo} · ${l.lotNo}${l.lotStatus ? ` (${l.lotStatus})` : ''}` },
            { title: 'Billed', render: (_, l) => `${formatDecimal(l.qty, 4)} × ${formatDecimal(l.unitPrice, 6)}` },
            { title: 'Received', render: (_, l) => formatDecimal(l.matchedQty, 4) },
            { title: 'Tax', render: (_, l) => (l.taxCode ? `${l.taxCode} ${formatDecimal(l.taxRate, 2)}%` : '—') },
            { title: 'Can debit', render: (_, l) => openFor(l) },
            {
              title: byAmount ? 'Amount (excl. tax)' : 'Quantity',
              render: (_, l) => (
                <InputNumber<string>
                  aria-label={`${byAmount ? 'Amount' : 'Quantity'} line ${l.lineNo}`}
                  stringMode
                  min="0"
                  precision={byAmount ? 2 : 4}
                  disabled={reason === 'RETURN_TO_VENDOR' && l.lotStatus !== 'REJECTED'}
                  value={values[l.invoiceLineId] || null}
                  onChange={(v) => setValues({ ...values, [l.invoiceLineId]: v ?? '' })}
                />
              ),
            },
          ]}
        />
      </Space>
    </Modal>
  );
}

function NoteDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<void> }) {
  const { can, user } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reversing, setReversing] = useState(false);
  const detail = useQuery({ queryKey: [...debitNotesKey, 'detail', id], queryFn: () => api<DebitNoteDto>(`/purch/debit-notes/${id}`) });
  const n = detail.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...debitNotesKey, 'detail', id] });
    await onChanged();
  };
  const manage = can('fin.debit_note.manage');
  const isReturn = n?.reason === 'RETURN_TO_VENDOR';
  const run = (path: 'submit' | 'post', title: string, content: string, done: string) =>
    modal.confirm({
      title,
      content,
      okText: path === 'submit' ? 'Submit' : 'Post',
      onOk: async () => {
        try {
          await api(`/purch/debit-notes/${id}/${path}`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success(done);
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });

  const posted = n?.status === 'POSTED' || n?.status === 'REVERSED';
  const lineCols = [
    { title: '#', dataIndex: 'lineNo', width: 40 },
    { title: 'Invoice line', render: (_: unknown, l: DebitNoteLineDto) => `${l.invoiceLineNo} · ${l.itemCode ?? ''} · ${l.grnDocNo ?? ''} · lot ${l.lotNo ?? ''}` },
    { title: 'Qty', render: (_: unknown, l: DebitNoteLineDto) => (l.qty ? formatDecimal(l.qty, 4) : '—') },
    { title: `Amount (${n?.currency ?? ''})`, render: (_: unknown, l: DebitNoteLineDto) => formatDecimal(l.amount) },
    { title: 'Tax', render: (_: unknown, l: DebitNoteLineDto) => (l.taxCode ? `${l.taxCode} ${formatDecimal(l.taxAmount)}` : '—') },
    ...(posted
      ? [
          { title: 'PKR', render: (_: unknown, l: DebitNoteLineDto) => formatDecimal(l.amountPkr) },
          ...(isReturn
            ? [
                { title: 'Stock value', render: (_: unknown, l: DebitNoteLineDto) => formatDecimal(l.stockValuePkr) },
                { title: 'Price var.', render: (_: unknown, l: DebitNoteLineDto) => formatDecimal(l.priceVariancePkr) },
              ]
            : []),
        ]
      : []),
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      width={960}
      title={n ? `Debit note ${n.docNo}` : 'Debit note'}
      extra={
        n && (
          <Space>
            {manage && n.status === 'DRAFT' && <Button onClick={() => setEditing(true)}>Edit</Button>}
            {manage && n.status === 'DRAFT' && (
              <Button onClick={() => run('submit', `Submit ${n.docNo}?`, 'Sent to the approval matrix. Whoever drafted or submitted it cannot approve it.', 'Submitted for approval')}>Submit</Button>
            )}
            {manage && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(n.status) && <Button danger onClick={() => setCancelling(true)}>Cancel</Button>}
            {manage && n.status === 'APPROVED' && !isReturn && (
              <Button type="primary" onClick={() => run('post', `Post ${n.docNo}?`, 'Posted on the note date: payables down, price variance and input tax back. It cannot be changed afterwards.', 'Debit note posted')}>
                Post
              </Button>
            )}
            {can('inv.lot.dispose') && n.status === 'APPROVED' && isReturn && (
              <Button type="primary" onClick={() => setReturning(true)}>Post return (QA witness)</Button>
            )}
            {can('fin.debit_note.reverse') && n.status === 'POSTED' && (
              <Button danger onClick={() => setReversing(true)}>Reverse</Button>
            )}
          </Space>
        )
      }
    >
      {n && (
        <>
          {n.status === 'PENDING_APPROVAL' && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Waiting for approval (My approvals)" />}
          {n.status === 'REVERSED' && (
            <Alert
              style={{ marginBottom: 12 }}
              type="error"
              showIcon
              message={`Reversed on ${formatDate(n.reversalDate)} by ${n.reversedByName}`}
              description={`${n.reversalReason} · journal ${n.reversalJournalDocNo ?? '—'}. What it took off the invoice is open again${isReturn ? '; the returned quantity is back in the lot' : ''}.`}
            />
          )}
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Reason">{REASON_LABEL[n.reason]}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={n.status} /></Descriptions.Item>
            <Descriptions.Item label="Vendor">{n.vendorCode} — {n.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Invoice">{n.invoiceDocNo} · {n.vendorInvoiceNo}</Descriptions.Item>
            <Descriptions.Item label="Date">{formatDate(n.dnDate)}</Descriptions.Item>
            <Descriptions.Item label="Total">
              {n.currency} {formatDecimal(n.totalAmount)} (goods {formatDecimal(n.goodsAmount)} + tax {formatDecimal(n.taxAmount)}) · PKR {formatDecimal(n.totalPkr)}
            </Descriptions.Item>
            <Descriptions.Item label="Posted">{n.postedByName ? `${formatDate(n.postingDate)} by ${n.postedByName} · journal ${n.journalDocNo ?? '—'}` : '—'}</Descriptions.Item>
            <Descriptions.Item label="Drafted by">{n.createdByName}</Descriptions.Item>
            {n.notes && <Descriptions.Item label="Notes" span={2}>{n.notes}</Descriptions.Item>}
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 16 }}>Lines</Typography.Title>
          <Table rowKey="id" size="small" pagination={false} dataSource={n.lines} columns={lineCols} />
        </>
      )}
      {editing && n && <NoteEditor note={n} onClose={() => setEditing(false)} onSaved={async () => { await reload(); }} />}
      {returning && n && <ReturnPostModal note={n} self={user?.username} onClose={() => setReturning(false)} onPosted={async () => { setReturning(false); void message.success('Return posted'); await reload(); }} />}
      <ESignModal
        open={reversing}
        title={`Reverse ${n?.docNo ?? ''}`}
        meaning="REVERSED"
        summary={
          isReturn
            ? 'Mirrors the journal today and puts the returned quantity back into the lot (still REJECTED) at the location it left. A QA witness signs for the stock movement. Refused once the lot is RETURNED.'
            : 'Mirrors the journal today; what the note took off the invoice is open again. Give the reason (e.g. claim withdrawn).'
        }
        countersign={isReturn ? 'required' : 'none'}
        countersignBy="QA witness"
        countersignNote="The QA witness (another person, holding qa.lot.witness) enters their own user name and password here."
        okText="Reverse debit note"
        onCancel={() => setReversing(false)}
        onSubmit={async (r) => {
          const witness = r.countersign ? { ...r.countersign, meaning: 'WITNESSED' as const } : undefined;
          await api(`/purch/debit-notes/${id}/reverse`, { method: 'POST', body: { signature: r.signature, ...(witness ? { witness } : {}) }, idempotencyKey: newIdempotencyKey() });
          void message.success('Debit note reversed');
          setReversing(false);
          await reload();
        }}
      />
      <ReasonModal
        open={cancelling}
        title={`Cancel ${n?.docNo ?? ''}?`}
        text="Nothing was posted. The note stays on record as CANCELLED and what it claimed can be claimed again."
        reasonRequired
        danger
        okText="Cancel note"
        onCancel={() => setCancelling(false)}
        onSubmit={async (reason) => {
          await api(`/purch/debit-notes/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
          setCancelling(false);
          await reload();
        }}
      />
    </Drawer>
  );
}

/** The Warehouse Manager posts the return; the QA witness enters their own user name and password at the same terminal. */
function ReturnPostModal({ note, self, onClose, onPosted }: { note: DebitNoteDto; self: string | undefined; onClose(): void; onPosted(): Promise<void> }) {
  const [locationId, setLocationId] = useState<string | undefined>();
  const [witness, setWitness] = useState({ username: '', password: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const line = note.lines[0];
  const ready = !!locationId && witness.username.trim() && witness.password && witness.reason.trim().length >= 3 && witness.username.trim() !== self;
  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/purch/debit-notes/${note.id}/post`, {
        method: 'POST',
        body: { locationId, witness: { username: witness.username.trim(), password: witness.password, meaning: 'WITNESSED', reason: witness.reason.trim() } },
        idempotencyKey: newIdempotencyKey(),
      });
      await onPosted();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`Post return ${note.docNo}`} okText="Post return" okButtonProps={{ disabled: !ready }} confirmLoading={busy} onOk={post} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} />}
        <Typography.Paragraph>
          {formatDecimal(line?.qty, 4)} of lot {line?.lotNo} ({line?.itemCode}) leave stock for {note.vendorCode}. Posted on {formatDate(note.dnDate)}: payables, stock and input tax down.
        </Typography.Paragraph>
        <RefSelect path="/master/locations" params={{ active: 'active' }} aria-label="Location the lot leaves" placeholder="Location the lot leaves" value={locationId} onChange={setLocationId} />
        <Typography.Text strong>QA witness</Typography.Text>
        <Input aria-label="Witness user name" placeholder="Witness user name (QA)" value={witness.username} onChange={(e) => setWitness({ ...witness, username: e.target.value })} />
        <Input.Password aria-label="Witness password" placeholder="Witness password" value={witness.password} onChange={(e) => setWitness({ ...witness, password: e.target.value })} />
        <Input aria-label="Witness reason" placeholder="What the witness saw (e.g. lot loaded for the vendor)" value={witness.reason} onChange={(e) => setWitness({ ...witness, reason: e.target.value })} />
        {witness.username.trim() && witness.username.trim() === self && <Typography.Text type="danger">The witness is another person.</Typography.Text>}
      </Space>
    </Modal>
  );
}
