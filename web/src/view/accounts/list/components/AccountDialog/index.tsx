import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  bindHostingGroup,
  type ManagedHostingGroup,
  deleteEmptyTenant,
  deleteAccountLogin,
  disableAccount,
  formatDashboardPhone,
  normalizeDashboardPhone,
  openAccount,
  resetAccountPassword,
  restoreAccount,
  registerTenant,
  TENANT_ROLE_LABELS,
  TenantRole,
  type DashboardAccount,
  type Tenant,
} from '@/api/dashboard-accounts';
import HostingGroupPicker from '../HostingGroupPicker';
import styles from './index.module.scss';

export type AccountAction =
  | { type: 'register' | 'open'; account?: undefined }
  | { type: 'deleteTenant'; tenant: Tenant; account?: undefined }
  | { type: 'reset' | 'disable' | 'restore' | 'deleteLogin' | 'bind'; account: DashboardAccount };
const titles = {
  register: '登记组织',
  deleteTenant: '删除组织',
  bind: '绑定托管小组',
  open: '开通账号',
  reset: '重置密码',
  disable: '停用账号',
  restore: '恢复账号',
  deleteLogin: '删除账号',
};

export default function AccountDialog({
  action,
  groups,
  tenants,
  onClose,
  onSaved,
}: {
  action: AccountAction;
  groups: ManagedHostingGroup[];
  tenants: Tenant[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = action.account;
  const [organization, setOrganization] = useState<string>(account?.organization ?? '');
  const [tenantRole, setTenantRole] = useState<TenantRole>(
    account?.tenantRole ?? TenantRole.GroupLeader,
  );
  const [groupId, setGroupId] = useState(account?.hostingGroupId ?? '');
  const showGroupPicker =
    action.type === 'bind' || (action.type === 'open' && tenantRole === TenantRole.GroupLeader);
  const selected = showGroupPicker ? groups.find((group) => group.id === groupId) : undefined;
  const binding = selected
    ? {
        groupId: selected.id,
        previousGroupId: account?.hostingGroupId ?? null,
        previousOwnerId: selected.ownerId,
      }
    : undefined;
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') || '');
    setBusy(true);
    setError('');
    try {
      switch (action.type) {
        case 'register':
          await registerTenant(String(data.get('name') ?? '').trim());
          break;
        case 'deleteTenant':
          await deleteEmptyTenant(action.tenant.id);
          break;
        case 'bind':
          if (!binding || !account?.memberId) throw new Error('请选择托管小组');
          await bindHostingGroup(account.memberId, account.organization, binding);
          break;
        case 'open': {
          const phone = normalizeDashboardPhone(String(data.get('phone') || ''));
          if (!phone) throw new Error('请输入有效的手机号');
          await openAccount({
            name: String(data.get('name') || '').trim(),
            phone,
            organization,
            tenantRole,
            password,
            ...(binding && { hostingBinding: binding }),
          });
          break;
        }
        case 'reset':
          await resetAccountPassword(action.account.userId!, password);
          break;
        case 'disable':
          await disableAccount(action.account.userId!);
          break;
        case 'restore':
          await restoreAccount(action.account.userId!);
          break;
        case 'deleteLogin':
          await deleteAccountLogin(action.account.userId!);
          break;
      }
      onSaved(action.type === 'deleteLogin' ? '账号已注销' : titles[action.type] + '成功');
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="account-action-title"
      className={styles.dialog}
      data-action={action.type}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="account-action-title">{titles[action.type]}</h2>
        {action.type === 'deleteTenant' && (
          <p>确认删除「{action.tenant.name}」？删除后无法恢复。</p>
        )}
        {action.type === 'register' && (
          <label>
            组织名称
            <input name="name" required maxLength={100} autoFocus />
          </label>
        )}
        {account && (
          <p>
            {account.name} · {account.loginName ?? formatDashboardPhone(account.phone)}
          </p>
        )}
        {action.type === 'open' && (
          <>
            <label>
              姓名
              <input name="name" maxLength={80} required />
            </label>
            <label>
              手机号
              <input name="phone" type="tel" required />
            </label>
            <label>
              所属组织
              <select
                name="organization"
                value={organization}
                onChange={(e) => {
                  setOrganization(e.target.value);
                  setGroupId('');
                }}
                required
              >
                <option value="" disabled>
                  请选择组织
                </option>
                {tenants.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              角色
              <select
                name="tenantRole"
                value={tenantRole}
                onChange={(event) => {
                  setTenantRole(event.target.value as TenantRole);
                  setGroupId(account?.hostingGroupId ?? '');
                }}
                required
              >
                {Object.values(TenantRole).map((role) => (
                  <option value={role} key={role}>
                    {TENANT_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {showGroupPicker && (
          <>
            {action.type === 'bind' && (
              <p>所属组织　{account!.tenant?.name ?? account!.organization}</p>
            )}
            <HostingGroupPicker
              groups={groups}
              account={account}
              organization={organization}
              selectedId={groupId}
              onSelect={setGroupId}
              required={action.type === 'bind'}
            />
            {!groups.length && <p>暂无可选小组，请在账号管理同步 Stride 目录。</p>}
          </>
        )}
        {(action.type === 'open' || action.type === 'reset') && (
          <label>
            {action.type === 'open' ? '初始密码' : '新密码'}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="至少 8 个字符"
              minLength={8}
              required
            />
          </label>
        )}
        {action.type === 'disable' && <p>停用后，该员工将失去后台访问权限。</p>}
        {action.type === 'restore' && <p>恢复后，该员工可以用原密码登录。</p>}
        {action.type === 'deleteLogin' && (
          <p>
            删除后，登录资格立即失效，账号将从名单中移除。成员档案、负责的小组和历史业务记录都会保留。
          </p>
        )}
        {error && (
          <p role="alert" className={styles.danger}>
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy} className={styles.primary}>
            {busy ? '正在保存…' : action.type === 'bind' ? '确认绑定' : titles[action.type]}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
