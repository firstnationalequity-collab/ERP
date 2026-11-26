// One colour per status everywhere (architecture §8: QUARANTINE yellow, APPROVED green, REJECTED red).
import { Tag } from 'antd';

const COLOURS: Record<string, string> = {
  QUARANTINE: 'gold',
  UNDER_TEST: 'blue',
  APPROVED: 'green',
  RELEASED: 'green',
  RELEASED_FOR_SALE: 'green',
  REJECTED: 'red',
  HOLD: 'volcano',
  EXPIRED: 'red',
  RETEST_DUE: 'orange',
  DESTROYED: 'default',
  RETURNED: 'default',
  OPEN: 'green',
  CLOSED: 'default',
  PENDING: 'gold',
  PENDING_APPROVAL: 'gold',
  MATCH_EXCEPTION: 'red', // vendor invoice outside the 3-way match tolerances (owner Q5)
  WAITING: 'default',
  SKIPPED: 'default',
  CANCELLED: 'default',
  DRAFT: 'default',
  POSTED: 'blue',
  REVERSED: 'purple',
  ACTIVE: 'green',
  INACTIVE: 'default',
  LOCKED: 'red',
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={COLOURS[status] ?? 'default'}>{status.replace(/_/g, ' ')}</Tag>;
}
