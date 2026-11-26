import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProcessingModelCall, listProcessingModelCalls } from '@/api/services/chat.service';
import styles from './index.module.scss';

export default function ModelCalls({ messageId }: { messageId: string }) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const key = ['message-processing-record-detail', messageId, 'model-calls'];
  const list = useQuery({
    queryKey: [...key, 'page', offset],
    queryFn: () => listProcessingModelCalls(messageId, offset),
  });
  const detail = useQuery({
    queryKey: [...key, 'body', selected],
    queryFn: () => getProcessingModelCall(messageId, selected!),
    enabled: Boolean(selected),
  });
  const changePage = (next: number) => {
    setSelected(null);
    setOffset(next);
  };

  return (
    <div className={styles.payloadCard}>
      {list.isPending ? (
        <span>正在读取调用清单…</span>
      ) : list.isError ? (
        <button type="button" className={styles.rawTabButton} onClick={() => void list.refetch()}>
          清单读取失败，重新读取
        </button>
      ) : (
        <>
          {list.data.calls.length === 0 && <span>这条流水没有留存模型 HTTP 原文。</span>}
          <div className={styles.rawTabs}>
            {list.data.calls.map((call, index) => (
              <button
                type="button"
                key={call.id}
                aria-pressed={selected === call.id}
                className={`${styles.rawTabButton} ${selected === call.id ? styles.rawTabButtonActive : ''}`}
                onClick={() => setSelected(call.id)}
              >
                第 {offset + index + 1} 次 · {call.provider} ·{' '}
                {call.httpStatus === null
                  ? '未收到响应'
                  : `HTTP ${call.httpStatus}${call.complete ? '' : ' · 响应未读完'}`}
              </button>
            ))}
            {offset > 0 && (
              <button
                type="button"
                className={styles.rawTabButton}
                onClick={() => changePage(Math.max(0, offset - 25))}
              >
                上一页
              </button>
            )}
            {list.data.nextOffset !== null && (
              <button
                type="button"
                className={styles.rawTabButton}
                onClick={() => changePage(list.data.nextOffset!)}
              >
                下一页
              </button>
            )}
          </div>
        </>
      )}
      {selected &&
        (detail.isPending ? (
          <span>正在读取原文…</span>
        ) : detail.isError ? (
          <button
            type="button"
            className={styles.rawTabButton}
            onClick={() => void detail.refetch()}
          >
            原文读取失败，重新读取
          </button>
        ) : (
          (['request', 'response'] as const).map((field) => {
            const payload = detail.data[field];
            return (
              <div key={field}>
                <div className={styles.payloadLabel}>
                  {field === 'request' ? '发给模型的请求体' : '供应商返回的响应体'}
                  {payload?.encoding === 'base64' && '（Base64）'}
                </div>
                <div className={styles.codeShell}>
                  <pre className={styles.codeBlock}>
                    {payload
                      ? payload.body || '（空正文）'
                      : field === 'request'
                        ? '未记录请求正文'
                        : '未收到响应正文'}
                  </pre>
                </div>
              </div>
            );
          })
        ))}
    </div>
  );
}
