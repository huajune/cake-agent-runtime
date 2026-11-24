import { DASHBOARD_ACCOUNT_PAGE_SIZE } from '@/api/dashboard-accounts';
import styles from './index.module.scss';

export default function AccountPagination({
  label,
  page,
  total,
  onChange,
}: {
  label: string;
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.ceil(total / DASHBOARD_ACCOUNT_PAGE_SIZE);
  if (pages < 2) return null;
  return (
    <nav className={styles.pagination} aria-label={label}>
      <button disabled={page === 1} onClick={() => onChange(page - 1)}>
        上一页
      </button>
      <span>
        第 {page} / {pages} 页
      </span>
      <button disabled={page >= pages} onClick={() => onChange(page + 1)}>
        下一页
      </button>
    </nav>
  );
}
