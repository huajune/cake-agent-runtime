import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DASHBOARD_ORGANIZATIONS,
  bindHostingGroup,
  type ManagedHostingGroup,
  disableAccount,
  moveAccount,
  normalizeDashboardPhone,
  openAccount,
  resetAccountPassword,
  type DashboardAccount,
  type DashboardOrganization,
} from '@/api/dashboard-accounts';
import HostingGroupPicker from '../HostingGroupPicker';
import styles from '../../styles/index.module.scss';

export type AccountAction =
  | { type: 'open'; account?: DashboardAccount }
  | { type: 'reset' | 'move' | 'disable' | 'bind'; account: DashboardAccount };
const titles = {
  bind: '绑定托管小组',
  open: '开通账号',
  reset: '重置密码',
  move: '调整所属组织',
  disable: '停用账号',
};

export default function AccountDialog({
  action,
  groups,
  onClose,
  onSaved,
}: {
  action: AccountAction;
  groups: ManagedHostingGroup[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = action.account;
  const [organization, setOrganization] = useState<string>(account?.organization ?? '');
  const [groupId, setGroupId] = useState(account?.hostingGroupId ?? '');
  const selected = groups.find((group) => group.id === groupId);
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
    const organization = String(
      data.get('organization') || account?.organization || '',
    ) as DashboardOrganization;
    setBusy(true);
    setError('');
    try {
      switch (action.type) {
        case 'bind':
          if (!binding || !account?.memberId) throw new Error('请选择托管小组');
          await bindHostingGroup(account.memberId, account.organization, binding);
          break;
        case 'open': {
          const phone = normalizeDashboardPhone(String(data.get('phone') || ''));
          if (!phone) throw new Error('请输入有效的手机号');
          await openAccount({
            ...(account?.memberId && { memberId: account.memberId }),
            name: String(data.get('name') || '').trim(),
            phone,
            organization,
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
        case 'move':
          await moveAccount(action.account.userId!, organization);
          break;
      }
      onSaved(titles[action.type] + '成功');
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
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="account-action-title">{titles[action.type]}</h2>
        {action.type !== 'open' && (
          <p>
            {account?.name} · {account?.loginName ?? account?.phone}
          </p>
        )}
        {action.type === 'open' && (
          <>
            <label>
              姓名
              <input
                name="name"
                defaultValue={account?.name}
                readOnly={Boolean(account)}
                maxLength={80}
                required
              />
            </label>
            <label>
              手机号
              <input
                name="phone"
                type="tel"
                defaultValue={account?.phone ?? ''}
                readOnly={Boolean(account?.phone)}
                required
              />
            </label>
          </>
        )}
        {(action.type === 'open' || action.type === 'move') && (
          <label>
            所属组织
            <select
              name="organization"
              value={organization}
              onChange={(e) => {
                setOrganization(e.target.value);
                setGroupId('');
              }}
              disabled={action.type === 'open' && Boolean(account)}
              required
            >
              <option value="" disabled>
                请选择组织
              </option>
              {Object.entries(DASHBOARD_ORGANIZATIONS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(action.type === 'open' || action.type === 'bind') && (
          <>
            {action.type === 'bind' && (
              <p>所属组织　{DASHBOARD_ORGANIZATIONS[account!.organization]}</p>
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
