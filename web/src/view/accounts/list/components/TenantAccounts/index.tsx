import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE,
  loadAccounts,
  TENANT_ROLE_LABELS,
  TenantRole,
  type TenantAccountSummary,
} from '@/api/dashboard-accounts';
import type { AccountAction } from '../AccountDialog';
import AccountPagination from '../AccountPagination';
import styles from './index.module.scss';

interface Props {
  tenant: TenantAccountSummary;
  initiallyExpanded: boolean;
  groupNames: ReadonlyMap<string, string>;
  administratorId?: string;
  onAction: (action: AccountAction) => void;
}

export default function TenantAccounts({
  tenant,
  initiallyExpanded,
  groupNames,
  administratorId,
  onAction,
}: Props) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [requestedPage, setPage] = useState(1);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(tenant.accountCount / DASHBOARD_ACCOUNT_PAGE_SIZE)),
  );
  const id = useId();
  const result = useQuery({
    queryKey: ['dashboard-accounts', 'members', tenant.id, page],
    queryFn: () => loadAccounts(tenant.id, page),
    enabled: expanded && tenant.accountCount > 0,
  });
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <h2>
        <button
          id={id}
          className={styles.heading}
          aria-expanded={expanded}
          aria-controls={id + '-members'}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight size={18} aria-hidden="true" />
          <span>{tenant.name}</span>
          <small>{tenant.accountCount} 个账号</small>
        </button>
      </h2>
      <div id={id + '-members'} hidden={!expanded}>
        {expanded &&
          (tenant.accountCount === 0 ? (
            <p>该组织暂无账号。</p>
          ) : result.isError ? (
            <p role="alert">
              {result.error.message} <button onClick={() => void result.refetch()}>重试</button>
            </p>
          ) : !result.data ? (
            <p role="status">正在加载账号…</p>
          ) : (
            <>
              <div className={styles.scroll}>
                <table aria-label={tenant.name + '账号'}>
                  <thead>
                    <tr>
                      <th scope="col">姓名</th>
                      <th scope="col">登录账号</th>
                      <th scope="col">负责小组</th>
                      <th scope="col">角色</th>
                      <th scope="col">状态</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.accounts.map((account) => (
                      <tr key={account.memberId ?? account.phone}>
                        <td>{account.name}</td>
                        <td>{account.loginName ?? account.phone ?? '待补手机号'}</td>
                        <td>
                          {account.hostingGroupId
                            ? (groupNames.get(account.hostingGroupId) ?? account.hostingGroupId)
                            : '—'}
                        </td>
                        <td>
                          {account.loginName
                            ? '系统管理员'
                            : account.tenantRole
                              ? TENANT_ROLE_LABELS[account.tenantRole]
                              : '—'}
                        </td>
                        <td>
                          <span
                            className={
                              account.disabled
                                ? styles.disabled
                                : account.userId
                                  ? styles.active
                                  : styles.pending
                            }
                          >
                            {account.disabled ? '已停用' : account.userId ? '已开通' : '待开通'}
                          </span>
                        </td>
                        <td>
                          {!account.disabled &&
                            account.tenantRole === TenantRole.GroupLeader &&
                            account.memberId && (
                              <button onClick={() => onAction({ type: 'bind', account })}>
                                绑定托管小组
                              </button>
                            )}
                          {account.disabled ? (
                            '—'
                          ) : !account.userId ? (
                            <button onClick={() => onAction({ type: 'open', account })}>
                              开通
                            </button>
                          ) : (
                            <>
                              <button onClick={() => onAction({ type: 'reset', account })}>
                                重置密码
                              </button>
                              {account.userId !== administratorId && (
                                <>
                                  <button onClick={() => onAction({ type: 'move', account })}>
                                    调整组织
                                  </button>
                                  <button
                                    className={styles.danger}
                                    onClick={() => onAction({ type: 'disable', account })}
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
              <AccountPagination
                label={tenant.name + '账号分页'}
                page={page}
                total={result.data.total}
                onChange={setPage}
              />
            </>
          ))}
      </div>
    </section>
  );
}
