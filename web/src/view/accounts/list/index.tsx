import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, UserPlus } from 'lucide-react';
import { loadAccounts, loadHostingDirectory, syncHostingDirectory } from '@/api/dashboard-accounts';
import { ACCOUNT_ONBOARDING_SOP_URL } from '@/constants';
import { useDashboardAccess } from '@/hooks/useDashboardAccess';
import AccountDialog, { type AccountAction } from './components/AccountDialog';
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
    queryKey: ['dashboard-accounts', page],
    queryFn: () => loadAccounts(page),
  });
  return (
    <section className={styles.page} aria-labelledby="accounts-title">
      <header>
        <div>
          <h1 id="accounts-title">账号管理</h1>
          <p>
            每人负责一个小组和组内所有托管号。总部可查看全部租户，其他员工可查看本租户的全部小组。
          </p>
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
        <button onClick={() => setAction({ type: 'register' })}>登记组织</button>
        <button className={styles.primary} onClick={() => setAction({ type: 'open' })}>
          <UserPlus size={17} />
          开通账号
        </button>
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
        <div className={styles.panel}>
          <div className={styles.scroll}>
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>登录账号</th>
                  <th>所属组织</th>
                  <th>负责小组</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {result.data?.accounts.map((account) => (
                  <tr key={account.memberId ?? account.phone}>
                    <td>{account.name}</td>
                    <td>{account.loginName ?? account.phone ?? '待补手机号'}</td>
                    <td>{account.tenant?.name ?? account.organization}</td>
                    <td>
                      {account.hostingGroupId
                        ? (groupNames.get(account.hostingGroupId) ?? account.hostingGroupId)
                        : '—'}
                    </td>
                    <td>{account.disabled ? '已停用' : account.userId ? '已开通' : '待开通'}</td>
                    <td>
                      {!account.disabled && !account.loginName && account.memberId && (
                        <button onClick={() => setAction({ type: 'bind', account })}>
                          绑定托管小组
                        </button>
                      )}
                      {account.disabled ? (
                        '—'
                      ) : !account.userId ? (
                        <button onClick={() => setAction({ type: 'open', account })}>开通</button>
                      ) : (
                        <>
                          <button onClick={() => setAction({ type: 'reset', account })}>
                            重置密码
                          </button>
                          {account.userId !== me?.userId && (
                            <>
                              <button onClick={() => setAction({ type: 'move', account })}>
                                调整组织
                              </button>
                              <button
                                className={styles.danger}
                                onClick={() => setAction({ type: 'disable', account })}
                              >
                                停用
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.data?.accounts.length && <p>暂无账号，可从右上角开通。</p>}
          <footer>
            <span>共 {result.data?.total ?? 0} 个账号</span>
            <nav aria-label="账号分页">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>第 {page} 页</span>
              <button
                disabled={page * 50 >= (result.data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </nav>
          </footer>
        </div>
      )}
      {action && (
        <AccountDialog
          action={action}
          groups={groups}
          tenants={directory.data?.tenants ?? []}
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
