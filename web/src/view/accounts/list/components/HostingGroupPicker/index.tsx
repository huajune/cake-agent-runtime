import type { DashboardAccount, ManagedHostingGroup } from '@/api/dashboard-accounts';
import styles from './index.module.scss';

export default function HostingGroupPicker({
  groups,
  organization,
  account,
  selectedId,
  onSelect,
  required,
}: {
  groups: ManagedHostingGroup[];
  organization: string;
  account?: DashboardAccount;
  selectedId: string;
  onSelect: (id: string) => void;
  required: boolean;
}) {
  const options = groups.filter((g) => !g.tenantId || g.tenantId === organization);
  const selected = options.find((g) => g.id === selectedId);
  const previous = groups.find((g) => g.id === account?.hostingGroupId);
  return (
    <div className={styles.picker}>
      <label>
        负责小组
        <select
          name="groupId"
          aria-label="负责小组"
          required={required}
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!organization}
        >
          <option value="">{required ? '请选择 Stride 小组' : '暂不绑定'}</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} · {g.bots.length} 个托管号{g.ownerName ? ' · ' + g.ownerName : ''}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p>
          {selected.bots.length
            ? selected.bots.map((b) => b.name || b.id).join('、')
            : '空组，扫码入组后自动登记托管号。'}
        </p>
      )}
      {selected &&
        ((selected.ownerId && selected.ownerId !== account?.memberId) ||
          (previous && previous.id !== selected.id)) && (
          <label
            className={styles.consent}
            key={selected.id + '-' + selected.ownerId + '-' + previous?.id}
          >
            <input type="checkbox" required />
            <span>
              {selected.ownerId && selected.ownerId !== account?.memberId
                ? '确认从' + selected.ownerName + '接手「' + selected.name + '」。'
                : ''}
              {previous && previous.id !== selected.id
                ? '原负责小组「' + previous.name + '」将空出。'
                : ''}
            </span>
          </label>
        )}
    </div>
  );
}
