// Landed cost (M3 task 4; owner Q21, Q2). The Purchase Officer enters each charge on a GRN (customs duty from the
// GD, freight, insurance, clearing, import taxes). On a DRAFT GRN the charge is posted with the GRN, so the lots are
// received at full cost; on a POSTED GRN it is a later bill, posted on its own date: the share for the stock the lot
// still holds goes into the lot, the consumed share to price variance. Finance keeps the charge types.
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Input, InputNumber, Modal, Select, Space, Table, Tabs, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateLandedCostRequest,
  CreateLandedCostTypeRequest,
  LandedCostBasis,
  LandedCostStatus,
  UpdateLandedCostRequest,
  type GrnDto,
  type LandedCostAllocationDto,
  type LandedCostDto,
  type LandedCostTypeDto,
} from '@albert/shared';
import { api, errorText, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { ReasonModal } from '../../components/ReasonModal';
import { ESignModal } from '../../components/ESignModal';
import { RefSelect } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDecimal, toBusinessDate } from '../../lib/format';

export const landedKey = ['purch', 'landed-costs'];
const typesKey = ['purch', 'landed-cost-types'];

const BASIS_LABEL: Record<LandedCostBasis, string> = { VALUE: 'By value', WEIGHT: 'By weight (kg per PO line)', GD_AMOUNTS: 'By GD amounts per PO line' };
const TAX_LABEL: Record<string, string> = { INPUT_TAX: 'Input sales tax', ADVANCE_TAX: 'Advance income tax' };

function useChargeTypes(activeOnly: boolean) {
  return useQuery({ queryKey: [...typesKey, activeOnly], queryFn: () => api<LandedCostTypeDto[]>(`/purch/landed-cost-types${activeOnly ? '?active=true' : ''}`) });
}

export function LandedCostPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Landed costs">
        Duties, freight, insurance and clearing go into the cost of the lots they belong to; import sales tax and income tax at import go to their tax accounts. Enter a charge on the
        GRN while it is a draft to receive the lots at full cost; a bill that comes later is posted on its own date.
      </PageHeader>
      <Tabs
        items={[
          {
            key: 'charges',
            label: 'Charges',
            children: (
              <DataTable<LandedCostDto>
                title="Landed-cost charges"
                path="/purch/landed-costs"
                queryKey={landedKey}
                filters={[statusFilter(LandedCostStatus)]}
                searchPlaceholder="Search number, GD / bill reference or GRN"
                onRowClick={(r) => setOpenId(r.id)}
                columns={[
                  { key: 'docNo', title: 'Number' },
                  { key: 'grnDocNo', title: 'GRN' },
                  { key: 'chargeTypeName', title: 'Charge', render: (r) => `${r.chargeTypeCode} — ${r.chargeTypeName}`, exportValue: (r) => r.chargeTypeCode },
                  { key: 'chargeDate', title: 'Date', render: (r) => formatDate(r.chargeDate), exportValue: (r) => formatDate(r.chargeDate) },
                  { key: 'amount', title: 'Amount (PKR)', render: (r) => formatDecimal(r.amount), exportValue: (r) => r.amount, exportFormat: 'money' },
                  { key: 'withGrn', title: 'When', render: (r) => (r.withGrn ? 'With the GRN' : 'Later bill'), exportValue: (r) => (r.withGrn ? 'With the GRN' : 'Later bill') },
                  { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
                ]}
              />
            ),
          },
          { key: 'types', label: 'Charge types', children: <ChargeTypes canManage={can('fin.master.manage')} /> },
        ]}
      />
      {openId && <LandedCostDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: landedKey })} />}
    </>
  );
}

// ---------------------------------------------------------------- charge types (Finance)

function ChargeTypes({ canManage }: { canManage: boolean }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const list = useChargeTypes(false);
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<LandedCostTypeDto | null>(null);
  const [form, setForm] = useState({ code: '', name: '', capitalise: true, taxRole: 'INPUT_TAX', isDuty: false, defaultBasis: 'VALUE' as LandedCostBasis });
  const [error, setError] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: typesKey });
  return (
    <>
      {canManage && (
        <Button style={{ marginBottom: 12 }} onClick={() => { setAdding(true); setError(null); }}>
          Add charge type
        </Button>
      )}
      <Table<LandedCostTypeDto>
        rowKey="id"
        size="small"
        pagination={false}
        loading={list.isLoading}
        dataSource={list.data ?? []}
        columns={[
          { title: 'Code', dataIndex: 'code' },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Into lot cost', render: (_, t) => (t.capitalise ? 'Yes' : `No — ${TAX_LABEL[t.taxRole ?? ''] ?? ''}`) },
          { title: 'Duty', render: (_, t) => (t.isDuty ? 'Yes' : '—') },
          { title: 'Default basis', render: (_, t) => (t.defaultBasis ? BASIS_LABEL[t.defaultBasis] : '—') },
          { title: 'Status', render: (_, t) => <StatusTag status={t.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
          ...(canManage
            ? [{ title: '', render: (_: unknown, t: LandedCostTypeDto) => <Button size="small" onClick={() => setToggling(t)}>{t.isActive ? 'Deactivate' : 'Activate'}</Button> }]
            : []),
        ]}
      />
      <Modal
        open={adding}
        title="Add charge type"
        okText="Add"
        onCancel={() => setAdding(false)}
        onOk={async () => {
          const parsed = CreateLandedCostTypeRequest.safeParse({
            code: form.code,
            name: form.name,
            capitalise: form.capitalise,
            taxRole: form.capitalise ? null : form.taxRole,
            isDuty: form.capitalise && form.isDuty,
            defaultBasis: form.capitalise ? form.defaultBasis : null,
          });
          if (!parsed.success) return setError(parsed.error.issues.map((i) => i.message).join('; '));
          try {
            await api('/purch/landed-cost-types', { method: 'POST', body: parsed.data });
            void message.success('Charge type added');
            setAdding(false);
            await reload();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {error && <Alert type="error" showIcon message={error} />}
          <Input aria-label="Code" placeholder="Code, e.g. DEMURRAGE" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <Input aria-label="Name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select
            aria-label="Into lot cost"
            value={form.capitalise ? 'yes' : 'no'}
            onChange={(v) => setForm({ ...form, capitalise: v === 'yes' })}
            options={[
              { value: 'yes', label: 'Capitalised: part of the lot cost' },
              { value: 'no', label: 'Not capitalised: a recoverable tax' },
            ]}
          />
          {form.capitalise ? (
            <>
              <Select aria-label="Duty" value={form.isDuty ? 'yes' : 'no'} onChange={(v) => setForm({ ...form, isDuty: v === 'yes', defaultBasis: 'VALUE' })} options={[{ value: 'no', label: 'Not a duty' }, { value: 'yes', label: 'A duty (may use GD amounts)' }]} />
              <Select
                aria-label="Default basis"
                value={form.defaultBasis}
                onChange={(v) => setForm({ ...form, defaultBasis: v })}
                options={LandedCostBasis.filter((b) => (form.isDuty ? b !== 'WEIGHT' : b !== 'GD_AMOUNTS')).map((b) => ({ value: b, label: BASIS_LABEL[b] }))}
              />
            </>
          ) : (
            <Select aria-label="Tax account" value={form.taxRole} onChange={(v) => setForm({ ...form, taxRole: v })} options={Object.entries(TAX_LABEL).map(([value, label]) => ({ value, label }))} />
          )}
        </Space>
      </Modal>
      <ReasonModal
        open={!!toggling}
        title={toggling ? `${toggling.isActive ? 'Deactivate' : 'Activate'} ${toggling.code}?` : ''}
        reasonRequired={!!toggling?.isActive}
        danger={!!toggling?.isActive}
        okText={toggling?.isActive ? 'Deactivate' : 'Activate'}
        onCancel={() => setToggling(null)}
        onSubmit={async (reason) => {
          await api(`/purch/landed-cost-types/${toggling!.id}/${toggling!.isActive ? 'deactivate' : 'activate'}`, { method: 'POST', body: { reason } });
          setToggling(null);
          await reload();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- charge editor

/** Enter or edit a charge on a GRN. The GRN gives the PO lines for GD amounts or weights. */
export function LandedCostEditor({ grn, charge, onClose, onSaved }: { grn: GrnDto; charge: LandedCostDto | null; onClose(): void; onSaved(id: string): Promise<void> }) {
  const types = useChargeTypes(true);
  const [v, setV] = useState({
    chargeTypeId: charge?.chargeTypeId,
    chargeDate: charge?.chargeDate ?? (grn.status === 'DRAFT' ? grn.grnDate : companyToday()),
    amount: charge?.foreignAmount ?? '',
    currency: charge?.currency ?? 'PKR',
    basis: charge?.basis ?? null,
    vendorId: charge?.vendorId ?? undefined,
    reference: charge?.reference ?? '',
    notes: charge?.notes ?? '',
  });
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries((charge?.inputs ?? []).map((i) => [i.poLineId, i.gdAmount ?? i.weightKg ?? ''])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const type = types.data?.find((t) => t.id === v.chargeTypeId);
  const basis = type?.capitalise ? (v.basis ?? type.defaultBasis ?? 'VALUE') : null;
  const poLines = [...new Map(grn.lines.map((l) => [l.poLineId, l])).values()];

  const save = async () => {
    const fields = {
      chargeTypeId: v.chargeTypeId,
      chargeDate: v.chargeDate,
      amount: v.amount,
      currency: v.currency,
      basis,
      vendorId: v.vendorId ?? null,
      reference: v.reference || null,
      notes: v.notes || null,
      inputs:
        basis === 'GD_AMOUNTS' || basis === 'WEIGHT'
          ? poLines
              .filter((l) => inputs[l.poLineId])
              .map((l) => (basis === 'GD_AMOUNTS' ? { poLineId: l.poLineId, gdAmount: inputs[l.poLineId] } : { poLineId: l.poLineId, weightKg: inputs[l.poLineId] }))
          : [],
    };
    const parsed = charge ? UpdateLandedCostRequest.safeParse(fields) : CreateLandedCostRequest.safeParse({ grnId: grn.id, ...fields });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => i.message).join('; '));
    setBusy(true);
    try {
      const saved = await api<LandedCostDto>(charge ? `/purch/landed-costs/${charge.id}` : '/purch/landed-costs', { method: charge ? 'PATCH' : 'POST', body: parsed.data });
      await onSaved(saved.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open width={760} title={`${charge ? `Edit ${charge.docNo}` : 'Add a charge'} on GRN ${grn.docNo}`} okText="Save" confirmLoading={busy} onOk={save} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={
            grn.status === 'DRAFT'
              ? 'The GRN is a draft: this charge is posted when the GRN is posted, on the GRN date, into the cost of its lots.'
              : 'The GRN is posted: this is a later bill, posted on its own date. The share for stock already used goes to price variance.'
          }
        />
        {error && <Alert type="error" showIcon message={error} />}
        <Select
          aria-label="Charge type"
          placeholder="Charge type"
          value={v.chargeTypeId}
          onChange={(id) => setV({ ...v, chargeTypeId: id, basis: null })}
          options={(types.data ?? []).map((t) => ({ value: t.id, label: `${t.code} — ${t.name}${t.capitalise ? '' : ' (tax, not cost)'}` }))}
          style={{ width: '100%' }}
        />
        <Space wrap>
          <DatePicker aria-label="Charge date" format="DD-MM-YYYY" value={dayjs(v.chargeDate)} onChange={(d) => d && setV({ ...v, chargeDate: toBusinessDate(d) })} />
          <Input aria-label="Currency" value={v.currency} maxLength={3} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} style={{ width: 80 }} />
          <InputNumber<string> aria-label="Amount" placeholder={`Amount (${v.currency})`} stringMode min="0" precision={2} value={v.amount || null} onChange={(a) => setV({ ...v, amount: a ?? '' })} style={{ width: 180 }} />
          {type?.capitalise && (
            <Select
              aria-label="Basis"
              value={basis}
              onChange={(b) => setV({ ...v, basis: b })}
              options={LandedCostBasis.filter((b) => (type.isDuty ? b !== 'WEIGHT' : b !== 'GD_AMOUNTS')).map((b) => ({ value: b, label: BASIS_LABEL[b] }))}
              style={{ width: 260 }}
            />
          )}
        </Space>
        <RefSelect path="/master/vendors" aria-label="Billed by" placeholder="Billed by (customs, forwarder, clearing agent)" value={v.vendorId} onChange={(id) => setV({ ...v, vendorId: id })} />
        <Input aria-label="Reference" placeholder="GD / bill number" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
        {(basis === 'GD_AMOUNTS' || basis === 'WEIGHT') && (
          <Table
            rowKey="poLineId"
            size="small"
            pagination={false}
            dataSource={poLines}
            columns={[
              { title: 'PO line item', render: (_, l) => `${l.itemCode} — ${l.itemName}` },
              {
                title: basis === 'GD_AMOUNTS' ? `GD amount (${v.currency})` : 'Weight (kg)',
                render: (_, l) => (
                  <InputNumber<string>
                    aria-label={`${basis === 'GD_AMOUNTS' ? 'GD amount' : 'Weight'} ${l.itemCode}`}
                    stringMode
                    min="0"
                    precision={basis === 'GD_AMOUNTS' ? 2 : 4}
                    value={inputs[l.poLineId] || null}
                    onChange={(x) => setInputs({ ...inputs, [l.poLineId]: x ?? '' })}
                  />
                ),
              },
            ]}
          />
        )}
        {v.currency !== 'PKR' && (
          <Typography.Text type="secondary">Converted at Finance's {v.currency} rate for the charge date (latest on or before it), refreshed when posted.</Typography.Text>
        )}
        <Input.TextArea rows={2} aria-label="Notes" placeholder="Notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------- charge drawer

export function LandedCostDrawer({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): Promise<unknown> }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState({ chargeDate: companyToday(), amount: '', reason: '' });
  const [approving, setApproving] = useState(false);
  const detail = useQuery({ queryKey: [...landedKey, 'detail', id], queryFn: () => api<LandedCostDto>(`/purch/landed-costs/${id}`) });
  const c = detail.data;
  const grn = useQuery({ queryKey: ['purch', 'grns', 'detail', c?.grnId], enabled: !!c && editing, queryFn: () => api<GrnDto>(`/purch/grns/${c!.grnId}`) });
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: [...landedKey, 'detail', id] });
    await qc.invalidateQueries({ queryKey: ['purch', 'grns'] });
    await onChanged();
  };
  const manage = can('purch.landed_cost.manage');
  const canCorrect = can('purch.landed_cost.correct');
  const isCorrection = !!c?.correctionOfId;
  const saveCorrection = async () => {
    try {
      await api(`/purch/landed-costs/${id}/correct`, {
        method: 'POST',
        body: { chargeDate: correction.chargeDate, amount: `-${correction.amount.replace(/^-/, '')}`, reason: correction.reason },
      });
      void message.success('Correction entered; a Finance Manager posts it');
      setCorrecting(false);
      await reload();
    } catch (err) {
      void message.error(errorText(err));
    }
  };
  const postIt = () =>
    modal.confirm({
      title: `Post ${c?.docNo}?`,
      content: c?.capitalise
        ? 'Posted on the charge date. For each GRN line, the share for the stock the lot still holds is added to the lot; the share already used goes to price variance. It cannot be changed afterwards.'
        : 'Posted on the charge date to the tax account, against landed-cost clearing. It cannot be changed afterwards.',
      okText: 'Post',
      onOk: async () => {
        try {
          await api(`/purch/landed-costs/${id}/post`, { method: 'POST', idempotencyKey: newIdempotencyKey() });
          void message.success('Landed cost posted');
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
      title={c ? `Landed cost ${c.docNo}` : 'Landed cost'}
      extra={
        c && (
          <Space>
            {manage && c.status === 'DRAFT' && !isCorrection && (!c.withGrn || c.grnStatus === 'DRAFT') && <Button onClick={() => setEditing(true)}>Edit</Button>}
            {manage && c.status === 'DRAFT' && <Button danger onClick={() => setCancelling(true)}>Cancel</Button>}
            {manage && c.status === 'DRAFT' && !c.withGrn && !isCorrection && <Button type="primary" onClick={postIt}>Post</Button>}
            {canCorrect && c.status === 'DRAFT' && isCorrection && <Button type="primary" onClick={() => setApproving(true)}>Approve and post</Button>}
            {manage && c.status === 'POSTED' && !isCorrection && <Button onClick={() => setCorrecting(true)}>Correct</Button>}
          </Space>
        )
      }
    >
      {c && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="GRN">{c.grnDocNo} (<StatusTag status={c.grnStatus} />)</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={c.status} /></Descriptions.Item>
            <Descriptions.Item label="Charge">{c.chargeTypeCode} — {c.chargeTypeName}{c.capitalise ? '' : ' (tax, not cost)'}</Descriptions.Item>
            <Descriptions.Item label="Amount (PKR)">
              {formatDecimal(c.amount)}
              {c.currency !== 'PKR' && ` = ${c.currency} ${formatDecimal(c.foreignAmount)} × ${c.exchangeRate} (rate of ${formatDate(c.exchangeRateDate)})`}
            </Descriptions.Item>
            {c.correctionOfId && <Descriptions.Item label="Corrects" span={2}>{c.correctionOfDocNo}: {c.correctionReason}</Descriptions.Item>}
            {c.corrections.length > 0 && (
              <Descriptions.Item label="Corrections" span={2}>
                {c.corrections.map((x) => `${x.docNo} ${formatDecimal(x.amount)} (${x.status})`).join(' · ')}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Charge date">{formatDate(c.chargeDate)}</Descriptions.Item>
            <Descriptions.Item label="Basis">{c.basis ? BASIS_LABEL[c.basis] : '—'}</Descriptions.Item>
            <Descriptions.Item label="When">{c.withGrn ? 'With the GRN: into the receipt cost' : 'Later bill'}</Descriptions.Item>
            <Descriptions.Item label="Billed by">{c.vendorName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Reference">{c.reference ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Posted">{c.postedByName ? `${formatDate(c.postingDate)} by ${c.postedByName} · journal ${c.journalDocNo ?? '—'}` : '—'}</Descriptions.Item>
            {c.notes && <Descriptions.Item label="Notes" span={2}>{c.notes}</Descriptions.Item>}
          </Descriptions>
          {c.inputs.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>{c.basis === 'GD_AMOUNTS' ? 'GD amounts' : 'Weights'} per PO line</Typography.Title>
              <Table
                rowKey="poLineId"
                size="small"
                pagination={false}
                dataSource={c.inputs}
                columns={[
                  { title: 'PO line', render: (_, i) => `${i.poLineNo} · ${i.itemCode}` },
                  { title: c.basis === 'GD_AMOUNTS' ? 'GD amount (PKR)' : 'Weight (kg)', render: (_, i) => (i.gdAmount ? formatDecimal(i.gdAmount) : formatDecimal(i.weightKg ?? '0', 4)) },
                ]}
              />
            </>
          )}
          {c.allocations.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>Allocation</Typography.Title>
              <Table<LandedCostAllocationDto>
                rowKey="grnLineId"
                size="small"
                pagination={false}
                dataSource={c.allocations}
                columns={[
                  { title: 'GRN line', render: (_, a) => `${a.lineNo} · ${a.itemCode}` },
                  { title: 'Lot', dataIndex: 'lotNo' },
                  { title: 'Charge (PKR)', render: (_, a) => formatDecimal(a.amount) },
                  { title: 'Lot still held', render: (_, a) => formatDecimal(a.heldQty, 4) },
                  { title: 'Into the lot', render: (_, a) => formatDecimal(a.heldAmount) },
                  { title: 'Price variance', render: (_, a) => formatDecimal(a.varianceAmount) },
                ]}
              />
            </>
          )}
        </>
      )}
      <Modal open={correcting} title={`Correct ${c?.docNo ?? ''}`} okText="Enter correction" onOk={saveCorrection} onCancel={() => setCorrecting(false)}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`A new document that takes an amount (${c?.currency ?? 'PKR'}) off this charge, allocated like it, on its own date. A Finance Manager posts it with an e-signature.`}
          />
          <DatePicker aria-label="Correction date" format="DD-MM-YYYY" value={dayjs(correction.chargeDate)} onChange={(d) => d && setCorrection({ ...correction, chargeDate: toBusinessDate(d) })} />
          <InputNumber<string> aria-label="Amount to take off" placeholder="Amount to take off" stringMode min="0" precision={2} value={correction.amount || null} onChange={(a) => setCorrection({ ...correction, amount: a ?? '' })} style={{ width: 200 }} />
          <Input.TextArea rows={2} aria-label="Reason" placeholder="Reason (at least 3 characters)" value={correction.reason} onChange={(e) => setCorrection({ ...correction, reason: e.target.value })} />
        </Space>
      </Modal>
      <ESignModal
        open={approving}
        title={`Approve and post ${c?.docNo ?? ''}`}
        meaning="APPROVED"
        summary={`Posts the correction (${c ? formatDecimal(c.amount) : ''} PKR) on its date: the share for stock still held comes off the lots, the rest off price variance. The person who entered it cannot sign.`}
        okText="Approve and post"
        onCancel={() => setApproving(false)}
        onSubmit={async (r) => {
          await api(`/purch/landed-costs/${id}/approve`, { method: 'POST', body: { signature: r.signature }, idempotencyKey: newIdempotencyKey() });
          void message.success('Correction posted');
          setApproving(false);
          await reload();
        }}
      />
      {editing && c && grn.data && <LandedCostEditor grn={grn.data} charge={c} onClose={() => setEditing(false)} onSaved={reload} />}
      <ReasonModal
        open={cancelling}
        title={`Cancel ${c?.docNo ?? ''}?`}
        text="Nothing was posted. The charge stays on record as CANCELLED."
        reasonRequired
        danger
        okText="Cancel charge"
        onCancel={() => setCancelling(false)}
        onSubmit={async (reason) => {
          await api(`/purch/landed-costs/${id}/cancel`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() });
          setCancelling(false);
          await reload();
        }}
      />
    </Drawer>
  );
}

/** For the GRN drawer: its charges, and "Add a charge" for the Purchase Officer. */
export function GrnLandedCosts({ grn, onChanged }: { grn: GrnDto; onChanged(): Promise<unknown> }) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const canAdd = can('purch.landed_cost.manage') && (grn.status === 'DRAFT' || grn.status === 'POSTED');
  if (grn.landedCosts.length === 0 && !canAdd) return null;
  return (
    <>
      <Space style={{ marginTop: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>Landed costs</Typography.Title>
        {canAdd && <Button size="small" onClick={() => setAdding(true)}>{grn.status === 'DRAFT' ? 'Add a charge' : 'Add a later bill'}</Button>}
      </Space>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        style={{ marginTop: 8 }}
        dataSource={grn.landedCosts}
        onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
        locale={{ emptyText: grn.status === 'DRAFT' ? 'No charges yet: charges entered now are posted with the GRN, into the lot cost' : 'No charges' }}
        columns={[
          { title: 'Number', dataIndex: 'docNo' },
          { title: 'Charge', render: (_, c) => `${c.chargeTypeCode} — ${c.chargeTypeName}${c.capitalise ? '' : ' (tax)'}` },
          { title: 'Amount (PKR)', render: (_, c) => formatDecimal(c.amount) },
          { title: 'When', render: (_, c) => (c.withGrn ? 'With the GRN' : 'Later bill') },
          { title: 'Status', render: (_, c) => <StatusTag status={c.status} /> },
        ]}
      />
      {adding && <LandedCostEditor grn={grn} charge={null} onClose={() => setAdding(false)} onSaved={async (id) => { await onChanged(); setOpenId(id); }} />}
      {openId && <LandedCostDrawer id={openId} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </>
  );
}
