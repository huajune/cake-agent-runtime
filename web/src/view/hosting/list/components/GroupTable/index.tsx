import { Building2, ChevronDown } from 'lucide-react';
import Switch from '@/components/Switch';
import type { summarizeHostingGroups } from '../../group-sections';
import styles from './index.module.scss';

interface GroupTableProps {
  summary: ReturnType<typeof summarizeHostingGroups>;
  isLoading: boolean;
  isError: boolean;
  isPending: boolean;
  onRetry: () => void;
  onToggleBlacklist: (groupId: string, enableHosting: boolean) => void;
}

export default function GroupTable({
  summary: { sections, total },
  isLoading,
  isError,
  isPending,
  onRetry,
  onToggleBlacklist,
}: GroupTableProps) {
  const ready = !isLoading && !isError;
  return (
    <section className={styles.section} aria-labelledby="hosting-groups-title">
      <header className={styles.header}>
        <h2 id="hosting-groups-title">小组托管状态</h2>
        <div className={styles.headerMeta}>
          <p>屏蔽小组后，AI 暂停回复，聊天记录仍会保留。</p>
          {ready && total > 0 && (
            <span className={styles.total}>
              <span>小组总数</span> <span>{total}</span>
            </span>
          )}
        </div>
      </header>

      {isError ? (
        <p className={styles.message} role="alert">
          暂时无法读取小组托管状态。 <button onClick={onRetry}>重试</button>
        </p>
      ) : isLoading ? (
        <p className={styles.message} role="status">
          正在加载小组…
        </p>
      ) : sections.length === 0 ? (
        <p className={styles.message}>暂无小组数据</p>
      ) : (
        <div className={styles.organizations}>
          {sections.map((section) => (
            <details
              key={section.id === null ? 'unassigned' : 'tenant-' + section.id}
              className={styles.organization}
              open={sections.length === 1}
            >
              <summary>
                <Building2 size={18} className={styles.orgIcon} aria-hidden="true" />
                <strong className={styles.orgTitle}>{section.name}</strong>
                <span className={styles.counts}>
                  <span className={styles.activeCount}>
                    托管中 <b>{section.groups.length - section.blocked}</b>
                  </span>
                  <span>
                    已屏蔽 <b>{section.blocked}</b>
                  </span>
                </span>
                <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
              </summary>
              <div className={styles.tableWrapper}>
                <table className={styles.table} aria-label={section.name + '小组托管状态'}>
                  <thead>
                    <tr>
                      <th scope="col">小组名称</th>
                      <th scope="col">描述</th>
                      <th scope="col">托管状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.groups.map((group) => {
                      const status = (
                        <span className={group.blocked ? styles.blocked : styles.active}>
                          {group.blocked ? '已屏蔽' : '托管中'}
                        </span>
                      );
                      return (
                        <tr key={group.id}>
                          <td>
                            <div className={styles.groupName}>{group.name}</div>
                            <div className={styles.groupId}>{group.id}</div>
                          </td>
                          <td className={styles.description}>{group.note || '—'}</td>
                          <td>
                            {group.canToggle ? (
                              <label className={styles.toggle}>
                                <Switch
                                  aria-label={group.name + '托管开关'}
                                  size="sm"
                                  checked={!group.blocked}
                                  onChange={(enabled) => onToggleBlacklist(group.id, enabled)}
                                  pending={isPending}
                                />
                                {status}
                              </label>
                            ) : (
                              <div className={styles.toggle}>
                                <span className={styles.readOnly}>仅查看</span>
                                {status}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
