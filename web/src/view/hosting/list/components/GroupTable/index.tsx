import { ChevronDown, FolderTree } from 'lucide-react';
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
  summary: { sections, total, blockedCount },
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
        <div>
          <h3 id="hosting-groups-title">小组托管状态</h3>
          <p>屏蔽小组后，AI 暂停回复，聊天记录仍会保留。</p>
        </div>
        {ready && total > 0 && (
          <span className={styles.total}>
            共 {total} 个小组 · {blockedCount} 个已屏蔽
          </span>
        )}
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
              key={section.name}
              className={styles.organization}
              open={sections.length === 1}
            >
              <summary>
                <span className={styles.orgIcon}>
                  <FolderTree size={17} aria-hidden="true" />
                </span>
                <span className={styles.orgTitle}>
                  <strong>{section.name}</strong>
                  <span>{section.groups.length} 个小组</span>
                </span>
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
              <ul className={styles.groups}>
                {section.groups.map((group) => (
                  <li key={group.id}>
                    <div className={styles.groupInfo}>
                      <strong>{group.name}</strong>
                      <span className={styles.groupId}>{group.id}</span>
                      {group.note && <span className={styles.note}>{group.note}</span>}
                    </div>
                    <div className={styles.toggle}>
                      <span className={group.blocked ? styles.blocked : styles.active}>
                        {group.blocked ? '已屏蔽' : '托管中'}
                      </span>
                      {group.canToggle ? (
                        <Switch
                          aria-label={group.name + '托管开关'}
                          size="sm"
                          checked={!group.blocked}
                          onChange={(enabled) => onToggleBlacklist(group.id, enabled)}
                          pending={isPending}
                        />
                      ) : (
                        <span className={styles.readOnly}>仅查看</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
