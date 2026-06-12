import { useState } from 'react';
import { formatDateTime } from '@/utils/format';
import type { CandidateBlacklistItem } from '@/api/types/candidate-blacklist.types';
import styles from './index.module.scss';

interface CandidateBlacklistProps {
  candidates: CandidateBlacklistItem[];
  isLoading: boolean;
  isPending: boolean;
  onAdd: (params: { targetId: string; reason: string; operator?: string }) => void;
  onRemove: (targetId: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  api: '外部系统',
};

export default function CandidateBlacklist({
  candidates,
  isLoading,
  isPending,
  onAdd,
  onRemove,
}: CandidateBlacklistProps) {
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');

  const canSubmit = targetId.trim().length > 0 && reason.trim().length > 0 && !isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd({
      targetId: targetId.trim(),
      reason: reason.trim(),
      operator: operator.trim() || undefined,
    });
    setTargetId('');
    setReason('');
    setOperator('');
  };

  const handleRemove = (item: CandidateBlacklistItem) => {
    const confirmed = window.confirm(
      `确定将候选人 ${item.contact_name || item.target_id} 移出黑名单？\n` +
        '已因命中黑名单被暂停的会话不会自动恢复，需在用户列表手动恢复。',
    );
    if (confirmed) {
      onRemove(item.target_id);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.addForm}>
        <input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="候选人标识（会话ID / 联系人ID）"
          aria-label="候选人标识"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="拉黑理由（必填）"
          aria-label="拉黑理由"
        />
        <input
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          placeholder="操作人（选填）"
          aria-label="操作人"
        />
        <button
          type="button"
          className={styles.addButton}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {isPending ? '处理中…' : '拉黑'}
        </button>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>候选人</th>
              <th>拉黑理由</th>
              <th>操作人</th>
              <th>拉黑时间</th>
              <th>命中回溯</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className={styles.loadingCell}>
                  加载中...
                </td>
              </tr>
            ) : candidates.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.loadingCell}>
                  暂无被拉黑的候选人
                </td>
              </tr>
            ) : (
              candidates.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className={styles.targetName}>
                      {item.contact_name || item.target_id}
                      <span className={styles.sourceTag}>
                        {SOURCE_LABELS[item.source] || item.source}
                      </span>
                    </div>
                    <div className={styles.targetId} title={item.target_id}>
                      {item.target_id}
                    </div>
                  </td>
                  <td className={styles.reasonCell} title={item.reason}>
                    {item.reason}
                  </td>
                  <td>{item.operator || '-'}</td>
                  <td className={styles.timeCell}>{formatDateTime(item.created_at)}</td>
                  <td className={styles.hitCell}>
                    {item.hit_count > 0 ? (
                      <>
                        <span className={styles.hitCount}>{item.hit_count} 次</span>
                        {item.last_hit_at && (
                          <div
                            className={styles.hitDetail}
                            title={`最近命中会话：${item.last_hit_chat_id || '-'}\n托管号：${item.last_hit_bot_id || '-'}`}
                          >
                            最近 {formatDateTime(item.last_hit_at)}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className={styles.noHit}>未命中</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.removeButton}
                      disabled={isPending}
                      onClick={() => handleRemove(item)}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
