// Vendor payments (M3 task 5, 5b). The AP Officer drafts a payment to one vendor, settling its posted invoices; submits
// it to the approval matrix (Finance Manager, never the creator); posts it once approved, with the bank reference or
// cheque number. WHT comes from the vendor's WHT section: the filer or non-filer rate by the vendor's ATL status, on the
// gross or the amount excluding sales tax (the code's base), refused while Finance has not confirmed them. A stale
// filer check is acknowledged by the approver. A foreign payment records the PKR paid; the difference from the
// invoices' PKR is an exchange gain or loss (owner Q4). A Finance Manager reverses a posted payment (bounced cheque).
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, InputNumber, Modal, Space, Table, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateVendorPaymentRequest,
  UpdateVendorPaymentRequest,
  VendorPaymentStatus,
  type OpenInvoiceDto,
  type VendorPaymentDto,
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

export const paymentsKey = ['purch', 'vendor-payments'];

export function VendorPaymentsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Vendor payments">
        Draft a payment against the vendor's posted invoices, submit it for approval (a Finance Manager approves; whoever drafted or submitted it cannot), then post it on the
        payment date. WHT is deducted at the vendor's WHT section.
      </PageHeader>
      <DataTable<VendorPaymentDto>
        title="Vendor payments"
        path="/purch/vendor-payments"
        queryKey={paymentsKey}
        filters={[statusFilter(VendorPaymentStatus)]}
        searchPlaceholder="Search number or cheque / transfer reference"
        onRowClick={(r) => setOpenId(r.id)}
        toolbar={can('fin.payment.manage') && <Button type="primary" onClick={() => setAdding(true)}>Draft payment</Button>}
        columns={[
          { key: 'docNo', title: 'Number' },
          { key: 'vendorName', title: 'Vendor', render: (r) => `${r.vendorCode} — ${r.vendorName}`, exportValue: (r) => r.vendorCode },
          { key: 'paymentDate', title: 'Date', render: (r) => formatDate(r.paymentDate), exportValue: (r) => formatDate(r.paymentDate) },
          { key: 'foreignAmount', title: 'Settles', render: (r) => `${r.currency} ${formatDecimal(r.foreignAmount)}`, exportValue: (r) => r.foreignAmount, exportFormat: 'money' },
          { key: 'pkrPaid', title: 'Gross PKR', render: (r) => formatDecimal(r.pkrPaid), exportValue: (r) => r.pkrPaid, exportFormat: 'money' },
          { key: 'whtAmount', title: 'WHT', render: (r) => formatDecimal(r.whtAmount), exportValue: (r) => r.whtAmount, exportFormat: 'money' },
          { key: 'netPaid', title: 'Bank', render: (r) => formatDecimal(r.netPaid), exportValue: (r) => r.netPaid, exportFormat: 'money' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {adding && (
        <PaymentEditor
          payment={null}
          onClose={() => setAdding(false)}
          onSaved={async (id) => {
            await qc.invalidateQueries({ queryKey: paymentsKey });
            setOpenId(id);
          }}
        />
      )}
      {openId && <PaymentDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: paymentsKey })} />}
    </>
  );
}

function PaymentEditor({ payment, onClose, onSaved }: { payment: VendorPaymentDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const [vendorId, setVendorId] = useState<string | undefined>(payment?.vendorId);
  const [head, setHead] = useState({
    paymentDate: payment?.paymentDate ?? companyToday(),
    pkrPaid: payment && payment.currency !== 'PKR' ? payment.pkrPaid : '',
    reference: payment?.reference ?? '',
    notes: payment?.notes ?? '',
  });
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries((payment?.allocations ?? []).map((a) => [a.invoiceId, a.amount])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = useQuery({
    queryKey: [...paymentsKey, 'open', vendorId],
    enabled: !!vendorId,
    queryFn: () => api<OpenInvoiceDto[]>(`/purch/vendors/${vendorId}/open-invoices`),
  });
  const chosen = Object.entries(amounts).filter(([, a]) => a);
  const currency = open.data?.find((i) => amounts[i.invoiceId])?.currency ?? payment?.currency ?? 'PKR';

  const save = async () => {
    const body = {
      paymentDate: head.paymentDate,
      ...(currency !== 'PKR' && head.pkrPaid ? { pkrPaid: head.pkrPaid } : {}),
      reference: head.reference || null,
      notes: head.notes || null,
      allocations: chosen.map(([invoiceId, amount]) => ({ invoiceId, amount })),
    };
    const parsed = payment ? UpdateVendorPaymentRequest.safeParse(body) : CreateVendorPaymentRequest.safeParse({ ...body, vendorId });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => i.message).join('; '));
    setBusy(true);
    try {
      const saved = await api<VendorPaymentDto>(payment ? `/purch/vendor-payments/${payment.id}` : '/purch/vendor-payments', { method: payment ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open width={900} title={payment ? `Edit ${payment.docNo}` : 'Draft a vendor payment'} okText="Save draft" confirmLoading={busy} onOk={save} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} />}
        {!payment && <RefSelect path="/master/vendors" params={{ status: 'ACTIVE' }} aria-label="Vendor" placeholder="Vendor" value={vendorId} onChange={(v) => { setVendorId(v); setAmounts({}); }} />}
        <Space wrap>
          <DatePicker aria-label="Payment date" format="DD-MM-YYYY" value={dayjs(head.paymentDate)} onChange={(d) => d && setHead({ ...head, paymentDate: toBusinessDate(d) })} />
          <Input aria-label="Reference" placeholder="Cheque / transfer no." value={head.reference} onChange={(e) => setHead({ ...head, reference: e.target.value })} style={{ width: 200 }} />
          {currency !== 'PKR' && (
            <InputNumber<string> aria-label="PKR paid" placeholder={`PKR paid for the ${currency}`} stringMode min="0" precision={2} value={head.pkrPaid || null} onChange={(v) => setHead({ ...head, pkrPaid: v ?? '' })} style={{ width: 220 }} />
          )}
        </Space>
        <Table<OpenInvoiceDto>
          rowKey="invoiceId"
          size="small"
          pagination={false}
          loading={open.isFetching}
          dataSource={open.data ?? []}
          locale={{ emptyText: vendorId ? 'No posted invoice of this vendor is open' : 'Pick the vendor' }}
          columns={[
            { title: 'Invoice', render: (_, i) => `${i.docNo} · ${i.vendorInvoiceNo}` },
            { title: 'Date', render: (_, i) => formatDate(i.invoiceDate) },
            { title: 'Due', render: (_, i) => formatDate(i.dueDate) },
            { title: 'Open', render: (_, i) => `${i.currency} ${formatDecimal(i.openAmount)}` },
            {
              title: 'Settle',
              render: (_, i) => (
                <InputNumber<string> aria-label={`Settle ${i.docNo}`} stringMode min="0" precision={2} value={amounts[i.invoiceId] || null}
                  onChange={(v) => setAmounts({ ...amounts, [i.invoiceId]: v ?? '' })} style={{ width: 150 }} />
              ),
            },
          ]}
        />
        <Typography.Text type="secondary">WHT is worked out from the vendor's WHT section when the draft is saved. One payment settles invoices of one currency.</Typography.Text>
        <Input.TextArea rows={2} aria-label="Notes" placeholder="Notes" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} />
      </Space>
    </Modal>
  );
}

function PaymentDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<unknown> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [posting, setPosting] = useState(false);
  const [reference, setReference] = useState('');
  const [reversing, setReversing] = useState(false);
  const detail = useQuery({ queryKey: [...paymentsKey, 'detail', id], queryFn: () => api<VendorPaymentDto>(`/purch/vendor-payments/${id}`) });
  const p = detail.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...paymentsKey, 'detail', id] });
    await onChanged();
  };
  const manage = can('fin.payment.manage');
  const action = (path: 'submit', title: string, content: string, done: string) =>
    modal.confirm({
      title,
      content,
      okText: 'Submit',
      onOk: async () => {
        try {
          await api(`/purch/vendor-payments/${id}/${path}`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success(done);
          await reload();
        } catch (err) {
          void message.error(errorText(err));
        }
      },
    });
  return (
    <Drawer
      open
      onClose={onClose}
      width={900}
      title={p ? `Vendor payment ${p.docNo}` : 'Vendor payment'}
      extra={
        p && (
          <Space>
            {manage && p.status === 'DRAFT' && <Button onClick={() => setEditing(true)}>Edit</Button>}
            {manage && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(p.status) && <Button danger onClick={() => setCancelling(true)}>Cancel</Button>}
            {manage && p.status === 'DRAFT' && (
              <Button type="primary" onClick={() => action('submit', `Submit ${p.docNo} for approval?`, 'A Finance Manager approves it in My approvals.', 'Submitted for approval')}>Submit</Button>
            )}
            {manage && p.status === 'APPROVED' && (
              <Button type="primary" onClick={() => { setReference(p.reference ?? ''); setPosting(true); }}>Post</Button>
            )}
            {can('fin.payment.reverse') && p.status === 'POSTED' && <Button danger onClick={() => setReversing(true)}>Reverse</Button>}
          </Space>
        )
      }
    >
      {p && (
        <>
          {p.whtRateUnconfirmed && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`WHT ${p.whtTaxCode} is not confirmed by Finance`} description="The payment cannot be submitted or posted until Finance confirms the filer and non-filer rates and the base (Masters → Tax codes)." />
          )}
          {p.filerCheckStale && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message={p.payeeFilerCheckedOn ? `The vendor's filer status was checked on ${formatDate(p.payeeFilerCheckedOn)}, more than ${p.filerCheckMaxDays} days ago` : "The vendor's filer status was never checked: the non-filer rate applies"}
              description="The approver must acknowledge this when approving. Re-check the ATL and update the vendor if the status changed."
            />
          )}
          {p.status === 'REVERSED' && (
            <Alert style={{ marginBottom: 12 }} type="error" showIcon message={`Reversed on ${formatDate(p.reversalDate)} by ${p.reversedByName}`} description={`${p.reversalReason} · journal ${p.reversalJournalDocNo ?? '—'}. The invoices it settled are open again.`} />
          )}
          {p.status === 'PENDING_APPROVAL' && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Waiting for a Finance Manager in My approvals" />}
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Vendor">{p.vendorCode} — {p.vendorName}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={p.status} /></Descriptions.Item>
            <Descriptions.Item label="Payment date">{formatDate(p.paymentDate)}</Descriptions.Item>
            <Descriptions.Item label="Reference">{p.reference ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Settles">{p.currency} {formatDecimal(p.foreignAmount)}</Descriptions.Item>
            <Descriptions.Item label="Gross PKR">{formatDecimal(p.pkrPaid)}</Descriptions.Item>
            <Descriptions.Item label="WHT">
              {p.whtTaxCode
                ? `${p.whtTaxCode} at ${formatDecimal(p.whtRate, 4)}% on ${formatDecimal(p.whtBasePkr)} (${p.whtBase === 'EXCL_SALES_TAX' ? 'excl.' : 'incl.'} sales tax): ${formatDecimal(p.whtAmount)}`
                : 'None (no WHT section on the vendor)'}
            </Descriptions.Item>
            <Descriptions.Item label="Out of the bank">{formatDecimal(p.netPaid)}</Descriptions.Item>
            <Descriptions.Item label="Filer (ATL)">
              {p.payeeIsFiler === null ? 'Not checked (non-filer rate)' : `${p.payeeIsFiler ? 'Filer' : 'Non-filer'}, checked ${formatDate(p.payeeFilerCheckedOn)}`}
              {p.filerWarningAckByName && <div style={{ fontSize: 12 }}>Stale check acknowledged by {p.filerWarningAckByName}</div>}
            </Descriptions.Item>
            <Descriptions.Item label="Exchange difference">{p.exchangeDiffPkr ? formatDecimal(p.exchangeDiffPkr) : '—'}</Descriptions.Item>
            <Descriptions.Item label="Drafted by">{p.createdByName}</Descriptions.Item>
            <Descriptions.Item label="Posted">{p.postedByName ? `${formatDate(p.postingDate)} by ${p.postedByName} · journal ${p.journalDocNo ?? '—'}` : '—'}</Descriptions.Item>
            {p.notes && <Descriptions.Item label="Notes" span={2}>{p.notes}</Descriptions.Item>}
          </Descriptions>
          <Typography.Title level={5} style={{ marginTop: 16 }}>Invoices settled</Typography.Title>
          <Table
            rowKey="invoiceId"
            size="small"
            pagination={false}
            dataSource={p.allocations}
            columns={[
              { title: 'Invoice', render: (_, a) => `${a.invoiceDocNo} · ${a.vendorInvoiceNo}` },
              { title: 'Due', render: (_, a) => formatDate(a.dueDate) },
              { title: `Settled (${p.currency})`, render: (_, a) => formatDecimal(a.amount) },
              { title: 'Payables (PKR)', render: (_, a) => (a.carryingPkr ? formatDecimal(a.carryingPkr) : '—') },
            ]}
          />
        </>
      )}
      {editing && p && <PaymentEditor payment={p} onClose={() => setEditing(false)} onSaved={async () => { await reload(); }} />}
      <Modal
        open={posting}
        title={`Post ${p?.docNo ?? ''}?`}
        okText="Post"
        okButtonProps={{ disabled: !reference.trim() }}
        onCancel={() => setPosting(false)}
        onOk={async () => {
          try {
            await api(`/purch/vendor-payments/${id}/post`, { method: 'POST', body: p?.reference ? {} : { reference: reference.trim() }, idempotencyKey: newIdempotencyKey() });
            void message.success('Payment posted');
            setPosting(false);
            await reload();
          } catch (err) {
            void message.error(errorText(err));
          }
        }}
      >
        <Typography.Paragraph>Posted on the payment date: payables down, bank and WHT out. It cannot be changed afterwards.</Typography.Paragraph>
        <Input aria-label="Bank reference or cheque number" placeholder="Bank reference or cheque number" value={reference} disabled={!!p?.reference} onChange={(e) => setReference(e.target.value)} />
      </Modal>
      <ESignModal
        open={reversing}
        title={`Reverse ${p?.docNo ?? ''}`}
        meaning="REVERSED"
        summary="Mirrors the payment's journal today (bank, WHT and payables back). The invoices it settled are open again. Give the reason (e.g. cheque bounced)."
        okText="Reverse payment"
        onCancel={() => setReversing(false)}
        onSubmit={async (r) => {
          await api(`/purch/vendor-payments/${id}/reverse`, { method: 'POST', body: { signature: r.signature }, idempotencyKey: newIdempotencyKey() });
          void message.success('Payment reversed');
          setReversing(false);
          await reload();
        }}
      />
      <ReasonModal
        open={cancelling}
        title={`Cancel ${p?.docNo ?? ''}?`}
        text="Nothing was posted. A pending approval is withdrawn."
        reasonRequired
        danger
        okText="Cancel payment"
        onCancel={() => setCancelling(false)}
        onSubmit={async (reason) => {
          await api(`/purch/vendor-payments/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
          setCancelling(false);
          await reload();
        }}
      />
    </Drawer>
  );
}
