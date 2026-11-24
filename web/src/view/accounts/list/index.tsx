import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, UserPlus } from 'lucide-react';
import {
  loadAccountTenants,
  loadHostingDirectory,
  syncHostingDirectory,
} from '@/api/dashboard-accounts';
import { ACCOUNT_ONBOARDING_SOP_URL } from '@/constants';
import { useDashboardAccess } from '@/hooks/useDashboardAccess';
import AccountDialog, { type AccountAction } from './components/AccountDialog';
import TenantAccounts from './components/TenantAccounts';
import AccountPagination from './components/AccountPagination';
import styles from './styles/index.module.scss';

export default function Accounts() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AccountAction | null>(null);
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const me = useDashboardAccess();
  const [syncing, setSyncing] = useState(false);
  const directory = useQuery({
    queryKey: ['hosting-management'],
    queryFn: loadHostingDirectory,
    refetchInterval: 60_000,
  });
  const groups = directory.data?.groups ?? [];
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['dashboard-accounts'] });
    void client.invalidateQueries({ queryKey: ['hosting-management'] });
    void client.invalidateQueries({ queryKey: ['group-list'] });
  };
  const sync = async () => {
    setSyncing(true);
    setNotice('');
    try {
      const fresh = await syncHostingDirectory();
      client.setQueryData(['hosting-management'], fresh);
      setNotice('Stride 目录已同步');
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '同步失败，请重试');
    } finally {
      setSyncing(false);
    }
  };
  const result = useQuery({
    queryKey: ['dashboard-accounts', 'organizations', page],
    queryFn: () => loadAccountTenants(page),
  });
  return (
    <section className={styles.page} aria-labelledby="accounts-title">
      <header>
        <div>
          <h1 id="accounts-title">账号管理</h1>
          <p>租户管理员负责整个组织。组长可绑定一个托管小组，管理组内的托管号。</p>
          <a
            className={styles.guideLink}
            href={ACCOUNT_ONBOARDING_SOP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            账号开通与托管绑定 SOP（飞书）
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => setAction({ type: 'register' })}>登记组织</button>
          <button className={styles.primary} onClick={() => setAction({ type: 'open' })}>
            <UserPlus size={17} />
            开通账号
          </button>
        </div>
      </header>
      <div className={styles.syncBar}>
        <span>
          {directory.data?.checkedAt
            ? '上次同步 ' +
              new Date(directory.data.checkedAt).toLocaleString('zh-CN', { hour12: false })
            : '托管小组目录'}
        </span>
        <button disabled={syncing} onClick={() => void sync()}>
          {syncing ? '正在同步…' : '同步 Stride'}
        </button>
      </div>
      {directory.isError && <p role="alert">托管目录暂不可用，请重新同步。</p>}
      {notice && <p role="status">{notice}</p>}
      {result.isLoading ? (
        <p role="status">正在加载账号…</p>
      ) : result.isError ? (
        <p role="alert">
          {result.error.message} <button onClick={() => void result.refetch()}>重试</button>
        </p>
      ) : (
        <div className={styles.organizations}>
          {result.data?.tenants.map((tenant, index) => (
            <TenantAccounts
              key={tenant.id}
              tenant={tenant}
              initiallyExpanded={index === 0}
              groupNames={groupNames}
              administratorId={me?.userId}
              onAction={setAction}
            />
          ))}
          {!result.data?.tenants.length && <p>暂无组织，可从右上角登记。</p>}
          <AccountPagination
            label="组织分页"
            page={page}
            total={result.data?.total ?? 0}
            onChange={setPage}
          />
        </div>
      )}
      {action && (
        <AccountDialog
          action={action}
          groups={groups}
          tenants={directory.data?.tenants ?? result.data?.tenants ?? []}
          onClose={() => setAction(null)}
          onSaved={(message) => {
            setAction(null);
            setNotice(message);
            refresh();
          }}
        />
      )}
    </section>
  );
}
