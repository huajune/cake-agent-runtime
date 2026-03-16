// 格式化时间（只显示时间）
export function formatTime(timestamp: string | number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// 格式化完整日期时间 (YYYY/MM/DD HH:mm:ss)
export function formatDateTime(timestamp: string | number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

// 格式化时长 (毫秒 -> 秒) - 与 monitoring.html 一致
export function formatDuration(ms: number, fractionDigits = 2): string {
  if (ms === undefined || ms === null) return '-';
  if (ms === 0) return '0 秒';
  const seconds = ms / 1000;
  return `${seconds.toFixed(fractionDigits)} 秒`;
}

// 格式化分钟标签
export function formatMinuteLabel(minute: string): string {
  if (!minute) return '';
  // "2025-11-24T09:30:00" -> "09:30"
  const date = new Date(minute);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 格式化小时标签（用于24小时趋势图）
export function formatHourLabel(hour: string): string {
  if (!hour) return '';
  // "2025-11-24T09:00:00" -> "09:00"
  const date = new Date(hour);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 格式化日期标签 - 与 monitoring.html 一致
export function formatDayLabel(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

// 格式化数字 (1000 -> 1k)
export function formatNumber(num: number): string {
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return num.toString();
}

// 格式化相对时间（几分钟前、几小时前等）
export function formatRelativeTime(timestamp: string | number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;

  // 超过7天显示具体日期
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ==================== JSON 格式化工具 ====================

/**
 * 格式化 JSON 对象为美化字符串
 */
export function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * 格式化工具调用的返回结果
 * 处理 Agent API 返回的各种格式：纯字符串、{type: 'text', text: '...'} 等
 */
export function formatToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.replace(/\\n/g, '\n');
  }
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    // 处理 {type: 'text', text: '...'} 格式
    if (obj.type === 'text' && typeof obj.text === 'string') {
      return obj.text.replace(/\\n/g, '\n');
    }
    return formatJson(result);
  }
  return String(result);
}
