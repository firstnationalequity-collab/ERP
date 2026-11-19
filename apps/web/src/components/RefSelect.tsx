// Pick a master record (item, customer, vendor, account …) by searching its list endpoint; show ids as
// "CODE — Name". Lists can be long, so the picker searches the server instead of loading every row.
import { useState } from 'react';
import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Page } from '@albert/shared';
import { api } from '../api/client';
import { buildQuery } from '../lib/query';
import { refLabel } from '../lib/labels';

type Row = Record<string, unknown> & { id: string };

/** The label of one record by id (cached), for showing a foreign key in a table or form. */
export function useRefLabel(path: string, id: string | null | undefined): string {
  const q = useQuery({
    queryKey: ['ref', path, id],
    queryFn: () => api<Row>(`${path}/${id}`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
  if (!id) return '';
  return q.data ? refLabel(q.data) : `#${id}`;
}

export function RefLabel({ path, id }: { path: string; id: string | null | undefined }) {
  return <>{useRefLabel(path, id)}</>;
}

interface Props {
  path: string;
  params?: Record<string, string>;
  value?: string;
  onChange(v: string | undefined): void;
  onBlur?(): void;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

export function RefSelect({ path, params = {}, value, onChange, onBlur, disabled, placeholder, 'aria-label': ariaLabel }: Props) {
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['ref', path, 'search', params, search],
    queryFn: () => api<Page<Row>>(`${path}${buildQuery({ ...params, search: search || undefined, page: 1, pageSize: 20 })}`),
    staleTime: 30_000,
  });
  const current = useRefLabel(path, value);
  const options = (list.data?.items ?? []).map((r) => ({ value: r.id, label: refLabel(r) }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: current });
  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      onSearch={setSearch}
      loading={list.isFetching}
      value={value}
      onChange={(v: string | undefined) => onChange(v)}
      onBlur={onBlur}
      disabled={disabled}
      placeholder={placeholder ?? 'Type to search'}
      aria-label={ariaLabel}
      options={options}
      notFoundContent={list.isFetching ? 'Searching…' : 'Nothing found'}
      style={{ width: '100%' }}
    />
  );
}
