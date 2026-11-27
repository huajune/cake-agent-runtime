import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronDown } from 'lucide-react';
import {
  DASHBOARD_ACCOUNT_PAGE_SIZE,
  formatDashboardPhone,
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
  hasHostingGroups: boolean;
  administratorId?: string;
  onAction: (action: AccountAction) => void;
}

export default function TenantAccounts({
  tenant,
  initiallyExpanded,
  groupNames,
  hasHostingGroups,
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
    <section className={styles.panel} aria-labelledby={id} data-expanded={expanded}>
      <h2>
        <button
          id={id}
          className={styles.heading}
          aria-expanded={expanded}
          aria-controls={id + '-members'}
          onClick={() => setExpanded(!expanded)}
        >
          <Building2 size={18} aria-hidden="true" />
          <span className={styles.tenantName}>{tenant.name}</span>
          <small>{tenant.accountCount} 个账号</small>
          <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
        </button>
      </h2>
      <div id={id + '-members'} hidden={!expanded}>
        {expanded &&
          (tenant.accountCount === 0 ? (
            <div className={styles.empty}>
              <p>{hasHostingGroups ? '该组织暂无账号，已关联托管小组。' : '该组织暂无账号。'}</p>
              {!tenant.hasMembers && !hasHostingGroups && (
                <button type="button" onClick={() => onAction({ type: 'deleteTenant', tenant })}>
                  删除组织
                </button>
              )}
            </div>
          ) : result.isError ? (
            <p role="alert">
              {result.error.message} <button onClick={() => void result.refetch()}>重试</button>
            </p>
          ) : !result.data ? (
            <p role="status">正在加载账号…</p>
          ) : (
            <>
              <table role="table" aria-label={tenant.name + '账号'}>
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
                    <tr key={account.userId}>
                      <td>{account.name}</td>
                      <td>
                        <span className={styles.mobileLabel} aria-hidden="true">
                          登录账号
                        </span>
                        {account.loginName ?? formatDashboardPhone(account.phone)}
                      </td>
                      <td>
                        <span className={styles.mobileLabel} aria-hidden="true">
                          负责小组
                        </span>
                        {account.hostingGroupId
                          ? (groupNames.get(account.hostingGroupId) ?? account.hostingGroupId)
                          : '—'}
                      </td>
                      <td>
                        <span className={styles.mobileLabel} aria-hidden="true">
                          角色
                        </span>
                        {account.loginName
                          ? '系统管理员'
                          : account.tenantRole
                            ? TENANT_ROLE_LABELS[account.tenantRole]
                            : '—'}
                      </td>
                      <td>
                        <span className={account.disabled ? styles.disabled : styles.active}>
                          {account.disabled ? '已停用' : '已开通'}
                        </span>
                      </td>
                      <td>
                        <div className={styles.actions}>
                          {!account.disabled &&
                            account.tenantRole === TenantRole.GroupLeader &&
                            account.memberId && (
                              <button onClick={() => onAction({ type: 'bind', account })}>
                                绑定托管小组
                              </button>
                            )}
                          {account.disabled ? (
                            !account.loginName ? (
                              <>
                                <button onClick={() => onAction({ type: 'restore', account })}>
                                  恢复账号
                                </button>
                                <button
                                  className={styles.danger}
                                  onClick={() => onAction({ type: 'deleteLogin', account })}
                                >
                                  删除账号
                                </button>
                              </>
                            ) : (
                              '—'
                            )
                          ) : (
                            <>
                              <button onClick={() => onAction({ type: 'reset', account })}>
                                重置密码
                              </button>
                              {account.userId !== administratorId && (
                                <button
                                  className={styles.danger}
                                  onClick={() => onAction({ type: 'disable', account })}
                                >
                                  停用
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
