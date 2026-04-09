import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import styles from './index.module.scss';

export interface GroupInviteIdModalValue {
  userId: string;
  botUserId: string;
  botImId: string;
}

interface GroupInviteIdModalProps {
  isOpen: boolean;
  value: GroupInviteIdModalValue;
  onClose: () => void;
  onSave: (nextValue: GroupInviteIdModalValue) => void;
}

export function GroupInviteIdModal({ isOpen, value, onClose, onSave }: GroupInviteIdModalProps) {
  const [draft, setDraft] = useState<GroupInviteIdModalValue>(value);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(value);
  }, [isOpen, value]);

  if (!isOpen) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>录入拉群 ID</h3>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <label className={styles.field}>
            <span>候选人 ID（imContactId）</span>
            <input
              value={draft.userId}
              placeholder="例如：wxid_xxx"
              onChange={(e) => setDraft((prev) => ({ ...prev, userId: e.target.value }))}
            />
          </label>

          <label className={styles.field}>
            <span>Bot User ID（botUserId）</span>
            <input
              value={draft.botUserId}
              placeholder="例如：zhangsan"
              onChange={(e) => setDraft((prev) => ({ ...prev, botUserId: e.target.value }))}
            />
          </label>

          <label className={styles.field}>
            <span>Bot IM ID（imBotId）</span>
            <input
              value={draft.botImId}
              placeholder="例如：wxid_bot_xxx"
              onChange={(e) => setDraft((prev) => ({ ...prev, botImId: e.target.value }))}
            />
          </label>

          <p className={styles.hint}>
            填入这三个字段后，测试请求会自动走 released 链路，`invite_to_group` 将执行真实拉群尝试。
          </p>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>
            取消
          </button>
          <button
            className={styles.saveBtn}
            onClick={() => {
              onSave({
                userId: draft.userId.trim(),
                botUserId: draft.botUserId.trim(),
                botImId: draft.botImId.trim(),
              });
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
