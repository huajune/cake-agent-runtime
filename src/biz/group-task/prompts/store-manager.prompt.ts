/**
 * 店长群通知 — 纯模板（不需要 AI）
 *
 * 格式：
 * 📋 今日面试名单（共N人）
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━
 * 姓名：张三
 * 电话：131****1162
 * 性别：男
 * 年龄：25岁
 * 面试岗位：xxx
 * 面试时间：2026-02-06 14:00
 * ━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 店长们上午好！今天的面试名单请查收~
 */

import { InterviewScheduleItem } from '@sponge/sponge.types';

interface StoreManagerTemplateData {
  interviews: InterviewScheduleItem[];
  date: string;
}

/** 手机号脱敏：131xxxx1162 → 131****1162 */
function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone;
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

/**
 * 生成店长群通知消息（模板拼装）
 */
export function buildStoreManagerMessage(data: StoreManagerTemplateData): string {
  const { interviews, date } = data;

  if (interviews.length === 0) {
    return `📋 今日面试名单（${date}）\n\n今日无面试安排`;
  }

  const lines: string[] = [];

  lines.push(`📋 今日面试名单（共${interviews.length}人）`);
  lines.push('');

  for (const item of interviews) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`姓名：${item.name}`);
    lines.push(`电话：${maskPhone(item.phone)}`);
    lines.push(`面试岗位：${item.jobName}`);
    lines.push(`面试时间：${item.interviewTime}`);
  }

  lines.push('');
  lines.push('店长们上午好！今天的面试名单请查收~');

  return lines.join('\n');
}
