// One list component for every screen (architecture §8): server-side search, filters and paging, plus Excel
// export of every row matching the current search and filters (not just the visible page).
import { useEffect, useState, type ReactNode } from 'react';
import { App, Button, Input, Select, Space, Table } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Page } from '@albert/shared';
import { api, errorText } from '../api/client';
import { buildQuery, pageCount, type QueryValue } from '../lib/query';
import { downloadExcel, exportFileName, type ExportColumn } from '../lib/excel';
import { companyToday } from '../lib/format';

export interface DataColumn<T> {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  /** Cell text for the Excel export; default = the field named by `key`, as text. */
  exportValue?: (row: T) => string;
  width?: number;
}

export interface FilterDef {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  width?: number;
}

/** Upper bound for one export, so a mistaken click cannot pull a whole ledger into the browser. */
export const EXPORT_MAX_ROWS = 20_000;

interface Props<T> {
  /** Used for the export file and sheet name. */
  title: string;
  /** API list path, e.g. "/master/items". */
  path: string;
  /** Query-key prefix; invalidate it after a change (e.g. ['master', 'items']). */
  queryKey: readonly unknown[];
  columns: DataColumn<T>[];
  filters?: FilterDef[];
  /** Fixed extra query parameters (e.g. a parent id). */
  params?: Record<string, QueryValue>;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  /** Largest page the endpoint accepts (masters 200, finance 500). */
  exportPageSize?: number;
  rowKey?: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Row buttons; shown last and never exported. */
  actions?: (row: T) => ReactNode;
}

function cellText<T>(row: T, key: string): string {
  const v = (row as Record<string, unknown>)[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export function DataTable<T extends object>(props: Props<T>) {
  const { title, path, queryKey, columns, filters = [], params = {}, searchPlaceholder, toolbar, pageSize = 25, exportPageSize = 200, onRowClick, actions } = props;
  const rowKey = props.rowKey ?? ((r: T) => String((r as { id?: unknown }).id));
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [filterValues, setFilterValues] = useState<Record<string, string | undefined>>(
    Object.fromEntries(filters.map((f) => [f.name, f.defaultValue])),
  );
  const [exporting, setExporting] = useState(false);

  const listParams = { ...params, ...filterValues, search: search || undefined };
  const paramsKey = JSON.stringify(params);
  useEffect(() => setPage(1), [paramsKey]); // a new date range or parent starts at page 1
  const list = useQuery({
    queryKey: [...queryKey, 'list', path, listParams, page, pageSize],
    queryFn: () => api<Page<T>>(`${path}${buildQuery({ ...listParams, page, pageSize })}`),
  });

  const exportAll = async () => {
    setExporting(true);
    try {
      const first = await api<Page<T>>(`${path}${buildQuery({ ...listParams, page: 1, pageSize: exportPageSize })}`);
      if (first.total > EXPORT_MAX_ROWS) {
        void message.warning(`${first.total} rows match; narrow the search or filters to at most ${EXPORT_MAX_ROWS} rows to export`);
        return;
      }
      const rows = [...first.items];
      for (let p = 2; p <= pageCount(first.total, exportPageSize); p += 1) {
        rows.push(...(await api<Page<T>>(`${path}${buildQuery({ ...listParams, page: p, pageSize: exportPageSize })}`)).items);
      }
      const exportColumns: ExportColumn<T>[] = columns.map((c) => ({ title: c.title, value: c.exportValue ?? ((r) => cellText(r, c.key)) }));
      await downloadExcel(exportFileName(title, companyToday()), title, exportColumns, rows);
    } catch (err) {
      void message.error(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder={searchPlaceholder ?? 'Search code or name'}
          allowClear
          onSearch={(v) => {
            setSearch(v.trim());
            setPage(1);
          }}
          style={{ width: 280 }}
        />
        {filters.map((f) => (
          <Select
            key={f.name}
            allowClear
            placeholder={f.label}
            aria-label={f.label}
            value={filterValues[f.name]}
            onChange={(v: string | undefined) => {
              setFilterValues((cur) => ({ ...cur, [f.name]: v }));
              setPage(1);
            }}
            options={f.options}
            style={{ width: f.width ?? 170 }}
          />
        ))}
        <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportAll()}>
          Excel
        </Button>
        {toolbar}
      </Space>
      <Table<T>
        rowKey={rowKey}
        size="middle"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={{ current: page, pageSize, total: list.data?.total ?? 0, onChange: setPage, showSizeChanger: false, showTotal: (t) => `${t} rows` }}
        scroll={{ x: true }}
        locale={{ emptyText: list.isError ? errorText(list.error) : 'Nothing found' }}
        onRow={onRowClick ? (r) => ({ onClick: () => onRowClick(r), style: { cursor: 'pointer' } }) : undefined}
        columns={[
          ...columns.map((c) => ({
            key: c.key,
            title: c.title,
            width: c.width,
            render: (_: unknown, r: T) => (c.render ? c.render(r) : cellText(r, c.key)),
          })),
          ...(actions
            ? [{ key: '__actions', title: '', render: (_: unknown, r: T) => <span onClick={(e) => e.stopPropagation()}>{actions(r)}</span> }]
            : []),
        ]}
      />
    </>
  );
}

/** Options for an active/inactive filter (masters with an is_active flag). */
export const ACTIVE_FILTER: FilterDef = {
  name: 'active',
  label: 'Active?',
  options: [
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
  ],
};

/** A status filter built from an enum list. */
export function statusFilter(statuses: readonly string[], name = 'status', label = 'Status'): FilterDef {
  return { name, label, options: statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })) };
}
