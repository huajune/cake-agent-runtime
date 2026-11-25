import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRealtimeMessageProcessing } from '@/hooks/chat/useRealtimeMessageProcessing';
import MessageProcessingDetailDrawer from '../list/components/MessageProcessingDetailDrawer';

export default function MessageProcessingDetailPage() {
  const [searchParams] = useSearchParams();
  const messageId = searchParams.get('messageId');
  useRealtimeMessageProcessing();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `处理记录详情 · ${previousTitle}`;
    return () => {
      document.title = previousTitle;
    };
  }, []);

  if (!messageId?.trim()) return <p role="alert">链接缺少流水编号，无法打开处理详情。</p>;
  return <MessageProcessingDetailDrawer messageId={messageId} />;
}
