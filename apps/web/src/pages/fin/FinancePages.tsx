// Finance masters (chart of accounts, cost centres, posting rules) and the read-only journals list.
// PLACEHOLDER accounts and rules are confirmed by Finance with a separate "Confirm" action; a confirmed one never
// goes back to placeholder (DB guard 0012). Journals are written only by the posting engine (rule 5).
import { useState } from 'react';
import { App, Button, DatePicker, Descriptions, Drawer, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import {
  AccountRole,
  AccountType,
  CreateAccountRequest,
  CreateCostCenterRequest,
  CreatePostingRuleRequest,
  PostingEvent,
  PostingEventRoles,
  PostingStatus,
  UpdateAccountRequest,
  UpdateCostCenterRequest,
  UpdatePostingRuleRequest,
  type AccountDto,
  type CostCenterDto,
  type JournalEntryDetailDto,
  type JournalEntryDto,
  type JournalLineDto,
  type PostingRuleDto,
} from '@albert/shared';
import { api, errorText } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ACTIVE_FILTER, DataTable, statusFilter } from '../../components/DataTable';
import { PageHeader } from '../../components/PageHeader';
import { RefLabel } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { formatDate, formatDateTime, formatDecimal } from '../../lib/format';
import { MasterPage, enumOptions, yesNo } from '../master/MasterPage';

const placeholderCol = <T extends { isPlaceholder: boolean }>() => ({
  key: 'isPlaceholder',
  title: 'Confirmed',
  render: (r: T) => (r.isPlaceholder ? <Tag color="orange">PLACEHOLDER</Tag> : 'Yes'),
  exportValue: (r: T) => yesNo(!r.isPlaceholder),
});
const activeCol = <T extends { isActive: boolean }>() => ({
  key: 'isActive',
  title: 'Status',
  render: (r: T) => <StatusTag status={r.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  exportValue: (r: T) => (r.isActive ? 'ACTIVE' : 'INACTIVE'),
});

/** "Confirm" button for a PLACEHOLDER account or rule: PATCH { isPlaceholder: false }. */
function ConfirmPlaceholder({ path, label, onDone }: { path: string; label: string; onDone(): Promise<void> }) {
  const { message, modal } = App.useApp();
  return (
    <Button
      type="link"
      onClick={() =>
        modal.confirm({
          title: `Confirm ${label}?`,
          content: 'Finance confirms it is correct. A confirmed record can never be marked placeholder again.',
          okText: 'Confirm',
          onOk: async () => {
            try {
              await api(path, { method: 'PATCH', body: { isPlaceholder: false } });
              void message.success('Confirmed');
              await onDone();
            } catch (err) {
              void message.error(errorText(err));
            }
          },
        })
      }
    >
      Confirm
    </Button>
  );
}

export function AccountsPage() {
  const { can } = useAuth();
  return (
    <MasterPage<AccountDto, typeof CreateAccountRequest, typeof UpdateAccountRequest>
      config={{
        title: 'Chart of accounts',
        intro: 'PLACEHOLDER accounts were seeded for Finance to confirm. Code and type never change; header accounts take no journal lines.',
        path: '/fin/accounts',
        noun: 'account',
        manageKey: 'fin.master.manage',
        exportPageSize: 500,
        filters: [ACTIVE_FILTER, { name: 'accountType', label: 'Type', options: enumOptions(AccountType) }],
        columns: [
          { key: 'code', title: 'Code' },
          { key: 'name', title: 'Name' },
          { key: 'type', title: 'Type' },
          { key: 'parentId', title: 'Parent', render: (r) => (r.parentId ? <RefLabel path="/fin/accounts" id={r.parentId} /> : '') },
          { key: 'isPostable', title: 'Postable', render: (r) => (r.isPostable ? 'Yes' : <Tag>HEADER</Tag>), exportValue: (r) => yesNo(r.isPostable) },
          placeholderCol<AccountDto>(),
          activeCol<AccountDto>(),
        ],
        isActive: (r) => r.isActive,
        create: {
          schema: CreateAccountRequest,
          initial: { isPostable: true },
          fields: [
            { name: 'code', label: 'Code', kind: 'text' },
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'type', label: 'Type', kind: 'select', options: enumOptions(AccountType) },
            { name: 'parentId', label: 'Parent (header) account', kind: 'ref', path: '/fin/accounts' },
            { name: 'isPostable', label: 'Postable (off = header account)', kind: 'switch' },
          ],
        },
        edit: {
          schema: UpdateAccountRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }, { label: 'Type', value: r.type }],
          initial: (r) => ({ name: r.name, parentId: r.parentId ?? '', isPostable: r.isPostable }),
          fields: () => [
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'parentId', label: 'Parent (header) account', kind: 'ref', path: '/fin/accounts', nullable: true },
            { name: 'isPostable', label: 'Postable (off = header account)', kind: 'switch' },
          ],
        },
        extraActions: (r, refresh) =>
          r.isPlaceholder && can('fin.master.manage') ? <ConfirmPlaceholder path={`/fin/accounts/${r.id}`} label={`account ${r.code}`} onDone={refresh} /> : null,
      }}
    />
  );
}

export function CostCentersPage() {
  return (
    <MasterPage<CostCenterDto, typeof CreateCostCenterRequest, typeof UpdateCostCenterRequest>
      config={{
        title: 'Cost centres',
        path: '/fin/cost-centers',
        noun: 'cost centre',
        manageKey: 'fin.master.manage',
        exportPageSize: 500,
        filters: [ACTIVE_FILTER],
        columns: [{ key: 'code', title: 'Code' }, { key: 'name', title: 'Name' }, activeCol<CostCenterDto>()],
        isActive: (r) => r.isActive,
        create: { schema: CreateCostCenterRequest, fields: [{ name: 'code', label: 'Code', kind: 'text' }, { name: 'name', label: 'Name', kind: 'text' }] },
        edit: {
          schema: UpdateCostCenterRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }],
          initial: (r) => ({ name: r.name }),
          fields: () => [{ name: 'name', label: 'Name', kind: 'text' }],
        },
      }}
    />
  );
}

const label = (s: string) => s.replace(/_/g, ' ');

export function PostingRulesPage() {
  const { can } = useAuth();
  return (
    <MasterPage<PostingRuleDto, typeof CreatePostingRuleRequest, typeof UpdatePostingRuleRequest>
      config={{
        title: 'Posting rules',
        intro: 'Which account each event posts to, per account role; a rule may name an item category, otherwise it is the default for every category.',
        path: '/fin/posting-rules',
        noun: 'posting rule',
        manageKey: 'fin.master.manage',
        exportPageSize: 500,
        filters: [ACTIVE_FILTER, { name: 'event', label: 'Event', options: enumOptions(PostingEvent), width: 240 }],
        searchPlaceholder: 'Search event, role or account',
        columns: [
          { key: 'event', title: 'Event', render: (r) => label(r.event) },
          { key: 'accountRole', title: 'Account role', render: (r) => label(r.accountRole) },
          { key: 'itemCategoryId', title: 'Item category', render: (r) => (r.itemCategoryId ? <RefLabel path="/master/item-categories" id={r.itemCategoryId} /> : 'All (default)') },
          { key: 'accountCode', title: 'Account', render: (r) => `${r.accountCode} — ${r.accountName}`, exportValue: (r) => `${r.accountCode} — ${r.accountName}` },
          placeholderCol<PostingRuleDto>(),
          activeCol<PostingRuleDto>(),
        ],
        isActive: (r) => r.isActive,
        create: {
          schema: CreatePostingRuleRequest,
          intro: <Typography.Paragraph type="secondary">Each event uses only some account roles; the form refuses a role the event does not use.</Typography.Paragraph>,
          fields: [
            { name: 'event', label: 'Event', kind: 'select', options: enumOptions(PostingEvent) },
            { name: 'accountRole', label: 'Account role', kind: 'select', options: enumOptions(AccountRole) },
            { name: 'itemCategoryId', label: 'Item category (empty = default for all)', kind: 'ref', path: '/master/item-categories' },
            { name: 'accountId', label: 'Account', kind: 'ref', path: '/fin/accounts', params: { active: 'active' } },
          ],
        },
        edit: {
          schema: UpdatePostingRuleRequest,
          readOnly: (r) => [
            { label: 'Event', value: label(r.event) },
            { label: 'Account role', value: label(r.accountRole) },
            { label: 'Roles this event uses', value: PostingEventRoles[r.event].map(label).join(', ') },
          ],
          initial: (r) => ({ accountId: r.accountId }),
          fields: () => [{ name: 'accountId', label: 'Account', kind: 'ref', path: '/fin/accounts', params: { active: 'active' } }],
        },
        extraActions: (r, refresh) =>
          r.isPlaceholder && can('fin.master.manage') ? <ConfirmPlaceholder path={`/fin/posting-rules/${r.id}`} label="this posting rule" onDone={refresh} /> : null,
      }}
    />
  );
}

// ---------------------------------------------------------------- journals (read only)

export function JournalsPage() {
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Journals">
        Every journal the system has posted. Journals are never edited: a correction is a reversing journal.
      </PageHeader>
      <DataTable<JournalEntryDto>
        title="Journals"
        path="/fin/journals"
        queryKey={['fin', 'journals']}
        exportPageSize={500}
        searchPlaceholder="Search document no. or narration"
        params={{ dateFrom: range?.[0]?.format('YYYY-MM-DD'), dateTo: range?.[1]?.format('YYYY-MM-DD') }}
        filters={[
          statusFilter(PostingStatus),
          { name: 'event', label: 'Event', options: enumOptions(PostingEvent), width: 240 },
          { name: 'kind', label: 'Kind', options: [{ value: 'SYSTEM', label: 'System (posted by modules)' }, { value: 'MANUAL', label: 'Manual (journal vouchers)' }] },
        ]}
        toolbar={<DatePicker.RangePicker format="DD-MM-YYYY" value={range} onChange={(v) => setRange(v)} aria-label="Date range" />}
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'docNo', title: 'Doc no.' },
          { key: 'entryDate', title: 'Date', render: (r) => formatDate(r.entryDate), exportValue: (r) => formatDate(r.entryDate) },
          { key: 'event', title: 'Event', render: (r) => (r.event ? label(r.event) : 'Manual'), exportValue: (r) => r.event ?? 'MANUAL' },
          { key: 'sourceType', title: 'Source', render: (r) => (r.sourceId ? `${r.sourceType} #${r.sourceId}` : r.sourceType), exportValue: (r) => (r.sourceId ? `${r.sourceType} #${r.sourceId}` : r.sourceType) },
          { key: 'narration', title: 'Narration' },
          { key: 'total', title: 'Amount (PKR)', render: (r) => formatDecimal(r.total, 2) },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
        ]}
      />
      {openId && <JournalDrawer id={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function JournalDrawer({ id, onOpen, onClose }: { id: string; onOpen(id: string): void; onClose(): void }) {
  const detail = useQuery({ queryKey: ['fin', 'journals', 'detail', id], queryFn: () => api<JournalEntryDetailDto>(`/fin/journals/${id}`) });
  const j = detail.data;
  return (
    <Drawer open onClose={onClose} width={900} title={j ? `Journal ${j.docNo}` : 'Journal'}>
      {detail.isError && <Typography.Text type="danger">{errorText(detail.error)}</Typography.Text>}
      {j && (
        <>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Date">{formatDate(j.entryDate)}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={j.status} /></Descriptions.Item>
            <Descriptions.Item label="Event">{j.event ? label(j.event) : 'Manual'}</Descriptions.Item>
            <Descriptions.Item label="Source">{j.sourceId ? `${j.sourceType} #${j.sourceId}` : j.sourceType}</Descriptions.Item>
            <Descriptions.Item label="Narration" span={2}>{j.narration}</Descriptions.Item>
            <Descriptions.Item label="Posted">{formatDateTime(j.postedAt)}</Descriptions.Item>
            <Descriptions.Item label="Amount">{formatDecimal(j.total, 2)}</Descriptions.Item>
            {j.reversalOf && <Descriptions.Item label="Reverses" span={2}><Typography.Link onClick={() => onOpen(j.reversalOf!)}>Open the reversed journal</Typography.Link></Descriptions.Item>}
            {j.reversalId && (
              <Descriptions.Item label="Reversed by" span={2}>
                <Typography.Link onClick={() => onOpen(j.reversalId!)}>Open the reversing journal</Typography.Link> ({formatDateTime(j.reversedAt)})
              </Descriptions.Item>
            )}
          </Descriptions>
          <Table<JournalLineDto>
            style={{ marginTop: 16 }}
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={j.lines}
            scroll={{ x: true }}
            columns={[
              { title: '#', dataIndex: 'lineNo', width: 50 },
              { title: 'Account', render: (_, l) => `${l.accountCode} — ${l.accountName}` },
              { title: 'Debit', align: 'right', render: (_, l) => (l.debit !== '0.00' && l.debit !== '0' ? formatDecimal(l.debit, 2) : '') },
              { title: 'Credit', align: 'right', render: (_, l) => (l.credit !== '0.00' && l.credit !== '0' ? formatDecimal(l.credit, 2) : '') },
              { title: 'Narration', dataIndex: 'narration' },
            ]}
            summary={() => j.status === 'DRAFT' ? null : (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} />
                <Table.Summary.Cell index={1}><b>Total</b></Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right"><b>{formatDecimal(j.total, 2)}</b></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right"><b>{formatDecimal(j.total, 2)}</b></Table.Summary.Cell>
                <Table.Summary.Cell index={4} />
              </Table.Summary.Row>
            )}
          />
        </>
      )}
    </Drawer>
  );
}
