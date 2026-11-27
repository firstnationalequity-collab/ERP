// Vendor ledger and AP ageing (M3 task 5). The ledger is the GL's payables for one vendor with a running balance;
// the ageing groups open invoices by days past their due date (invoice date + the vendor's payment terms).
import { useState } from 'react';
import dayjs from 'dayjs';
import { DatePicker, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ApAgeingDto, ApAgeingVendorDto, VendorLedgerDto, VendorLedgerLineDto } from '@albert/shared';
import { api } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { RefSelect } from '../../components/RefSelect';
import { companyToday, decimalSign, formatDate, formatDecimal, toBusinessDate } from '../../lib/format';
import { buildQuery } from '../../lib/query';

const SOURCE_LABEL: Record<string, string> = { VENDOR_INVOICE: 'Invoice', VENDOR_PAYMENT: 'Payment', LOT_RETURNED: 'Debit note' };

export function VendorLedgerPage() {
  const [vendorId, setVendorId] = useState<string | undefined>();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const ledger = useQuery({
    queryKey: ['purch', 'vendor-ledger', vendorId, range],
    enabled: !!vendorId,
    queryFn: () => api<VendorLedgerDto>(`/purch/vendors/${vendorId}/ledger${buildQuery(range)}`),
  });
  const l = ledger.data;
  return (
    <>
      <PageHeader title="Vendor ledger">What the company owes the vendor, line by line from the payables account, in PKR. Foreign invoices and payments show their currency amount.</PageHeader>
      <Space wrap style={{ marginBottom: 12 }}>
        <div style={{ width: 360 }}>
          <RefSelect path="/master/vendors" aria-label="Vendor" placeholder="Vendor" value={vendorId} onChange={setVendorId} />
        </div>
        <DatePicker.RangePicker
          aria-label="Period"
          format="DD-MM-YYYY"
          value={range.from && range.to ? [dayjs(range.from), dayjs(range.to)] : null}
          onChange={(v) => setRange(v && v[0] && v[1] ? { from: toBusinessDate(v[0]), to: toBusinessDate(v[1]) } : {})}
        />
      </Space>
      {l && (
        <>
          <Typography.Paragraph>
            Opening {formatDecimal(l.opening)} · closing <b>{formatDecimal(l.closing)}</b> PKR owed
          </Typography.Paragraph>
          <Table<VendorLedgerLineDto>
            rowKey={(r) => `${r.journalDocNo}-${r.debit}-${r.credit}-${r.balance}`}
            size="small"
            pagination={{ pageSize: 100 }}
            dataSource={l.lines}
            columns={[
              { title: 'Date', render: (_, r) => formatDate(r.date) },
              { title: 'Document', render: (_, r) => `${SOURCE_LABEL[r.sourceType] ?? r.sourceType} ${r.sourceDocNo ?? ''}` },
              { title: 'Journal', dataIndex: 'journalDocNo' },
              { title: 'Narration', dataIndex: 'narration' },
              { title: 'Currency', render: (_, r) => (r.currency && r.currency !== 'PKR' ? `${r.currency} ${formatDecimal(r.foreignAmount)}` : '') },
              { title: 'Debit', align: 'right', render: (_, r) => (decimalSign(r.debit) !== 0 ? formatDecimal(r.debit) : '') },
              { title: 'Credit', align: 'right', render: (_, r) => (decimalSign(r.credit) !== 0 ? formatDecimal(r.credit) : '') },
              { title: 'Balance', align: 'right', render: (_, r) => formatDecimal(r.balance) },
            ]}
          />
        </>
      )}
    </>
  );
}

export function ApAgeingPage() {
  const [asOf, setAsOf] = useState(companyToday());
  const ageing = useQuery({ queryKey: ['purch', 'ap-ageing', asOf], queryFn: () => api<ApAgeingDto>(`/purch/ap-ageing?asOf=${asOf}`) });
  const money = (v: string) => (decimalSign(v) !== 0 ? formatDecimal(v) : '');
  const t = ageing.data?.totals;
  return (
    <>
      <PageHeader title="AP ageing">Open vendor invoices by days past their due date (invoice date + the vendor's payment terms), in PKR, as of the chosen day.</PageHeader>
      <DatePicker aria-label="As of" format="DD-MM-YYYY" value={dayjs(asOf)} onChange={(d) => d && setAsOf(toBusinessDate(d))} style={{ marginBottom: 12 }} />
      <Table<ApAgeingVendorDto>
        rowKey="vendorId"
        size="small"
        loading={ageing.isLoading}
        pagination={false}
        dataSource={ageing.data?.vendors ?? []}
        expandable={{
          expandedRowRender: (v) => (
            <Table
              rowKey="invoiceId"
              size="small"
              pagination={false}
              dataSource={v.invoices}
              columns={[
                { title: 'Invoice', render: (_, i) => `${i.docNo} · ${i.vendorInvoiceNo}` },
                { title: 'Date', render: (_, i) => formatDate(i.invoiceDate) },
                { title: 'Due', render: (_, i) => formatDate(i.dueDate) },
                { title: 'Days past due', dataIndex: 'daysPastDue' },
                { title: 'Open', render: (_, i) => `${i.currency} ${formatDecimal(i.openAmount)}` },
                { title: 'Open (PKR)', render: (_, i) => formatDecimal(i.openPkr) },
              ]}
            />
          ),
        }}
        columns={[
          { title: 'Vendor', render: (_, v) => `${v.vendorCode} — ${v.vendorName}` },
          { title: 'Terms (d)', dataIndex: 'paymentTermsDays' },
          { title: 'Not due', align: 'right', render: (_, v) => money(v.notDue) },
          { title: '1–30', align: 'right', render: (_, v) => money(v.d1to30) },
          { title: '31–60', align: 'right', render: (_, v) => money(v.d31to60) },
          { title: '61–90', align: 'right', render: (_, v) => money(v.d61to90) },
          { title: 'Over 90', align: 'right', render: (_, v) => money(v.over90) },
          { title: 'Total', align: 'right', render: (_, v) => <b>{formatDecimal(v.total)}</b> },
        ]}
        summary={() =>
          t && (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">{money(t.notDue)}</Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">{money(t.d1to30)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">{money(t.d31to60)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">{money(t.d61to90)}</Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">{money(t.over90)}</Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right"><b>{formatDecimal(t.total)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          )
        }
      />
    </>
  );
}
