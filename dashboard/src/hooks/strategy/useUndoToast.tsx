import toast from 'react-hot-toast';
import { Undo2 } from 'lucide-react';

/**
 * 显示带撤回按钮的删除提示
 * 延迟执行删除操作，用户可在 3 秒内撤回
 */
export function showUndoToast(
  message: string,
  onConfirm: () => void,
  onUndo: () => void,
  toastId: string,
): { cancel: () => void } {
  const timeoutId = setTimeout(() => {
    onConfirm();
  }, 3500);

  const cancel = () => {
    clearTimeout(timeoutId);
    onUndo();
  };

  toast.custom(
    (t) => (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: 'rgba(255, 255, 255, 0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(148, 163, 184, 0.2)',
          borderRadius: '12px',
          padding: '12px 16px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
          fontSize: '14px',
          color: '#1e293b',
        }}
      >
        <span>{message}</span>
        <button
          onClick={() => {
            cancel();
            toast.dismiss(t.id);
          }}
          style={{
            background: 'none',
            border: '1px solid #6366f1',
            color: '#6366f1',
            borderRadius: '6px',
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <Undo2 size={14} /> 撤回
        </button>
      </div>
    ),
    { duration: 3000, id: toastId },
  );

  return { cancel };
}
