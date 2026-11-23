import { useState, type FormEvent } from 'react';
import {
  confirmHostingHandover,
  type HostingManagementDirectory,
  type HostingHandover,
} from '@/api/dashboard-accounts';
import styles from './index.module.scss';

const timeLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
function ReviewRow({
  item,
  directory,
  onSaved,
}: {
  item: HostingHandover;
  directory: HostingManagementDirectory;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = directory.groups.find((g) => g.id === item.toGroupId);
  const label = (id: string | null) => {
    const group = directory.groups.find((g) => g.id === id);
    if (!group) return id || '已离开 Stride 小组';
    const tenant = directory.tenants.find(({ id }) => id === group.tenantId)?.name;
    return group.name + '（' + (tenant || '待绑定组织') + '）';
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('effectiveAt') || '');
    const time = new Date(value);
    if (
      !Number.isFinite(time.getTime()) ||
      time.getTime() > Date.now() ||
      time.getTime() < Date.parse(item.targetChangedSince ?? item.reviewFrom)
    ) {
      setError('请填写上次核实后、当前时间之前的实际交接时间');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await confirmHostingHandover(item.id, item.toGroupId, time.toISOString());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '交接未完成，请刷新目录后核对');
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <div className={styles.line}>
        <div>
          <strong>{item.botName}</strong>
          <p>
            {label(item.fromGroupId)} → {label(item.toGroupId)}
          </p>
        </div>
        {!editing && (
          <button
            disabled={Boolean(item.toGroupId && !target?.tenantId)}
            onClick={() => setEditing(true)}
          >
            核对交接
          </button>
        )}
      </div>
      {item.toGroupId && !target?.tenantId && <p>请先将目标小组绑定到所属组织。</p>}
      {editing && (
        <form onSubmit={submit}>
          <p>
            待核对时段从 {timeLabel(item.reviewFrom)} 开始，{timeLabel(item.detectedAt)}{' '}
            首次发现变动。
          </p>
          {item.targetChangedSince && (
            <p>
              待核对期间小组再次变动。请填写 {timeLabel(item.targetChangedSince)}{' '}
              之后的本次交接时间，期间归属另行核实。
            </p>
          )}
          <label>
            实际交接时间（本地时间）
            <input type="datetime-local" step="1" name="effectiveAt" required />
          </label>
          <div className={styles.buttons}>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
            <button disabled={busy}>{busy ? '正在保存…' : '确认交接'}</button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
export default function HandoverReview({
  directory,
  onSaved,
}: {
  directory: HostingManagementDirectory;
  onSaved: () => void;
}) {
  if (!directory.handovers.length) return null;
  return (
    <section className={styles.review}>
      <h2>待确认的托管号交接（{directory.handovers.length}）</h2>
      <ul>
        {directory.handovers.map((item) => (
          <ReviewRow
            key={item.id + '-' + item.toGroupId}
            item={item}
            directory={directory}
            onSaved={onSaved}
          />
        ))}
      </ul>
    </section>
  );
}
