/**
 * 店长群通知 — 纯模板（不需要 AI）
 *
 * 主消息格式：
 * 📋 今日面试名单（共N人）
 *
 * 姓名：张三
 * 电话：13100101162
 * 面试岗位：xxx
 * 面试时间：2026-02-06 14:00
 *
 * 跟随消息（单独发送）：
 * 店长们上午好！今天的面试名单请查收~
 */

import { InterviewScheduleItem } from '@sponge/sponge.types';

interface StoreManagerTemplateData {
  interviews: InterviewScheduleItem[];
  date: string;
}

export interface StoreManagerMessageResult {
  main: string;
  followUp?: string;
}

/**
 * 生成店长群通知消息（模板拼装）
 */
export function buildStoreManagerMessage(
  data: StoreManagerTemplateData,
): StoreManagerMessageResult {
  const { interviews, date } = data;

  if (interviews.length === 0) {
    return { main: `📋 今日面试名单（${date}）\n\n今日无面试安排` };
  }

  const lines: string[] = [];

  lines.push(`📋 今日面试名单（共${interviews.length}人）`);

  for (const item of interviews) {
    lines.push('');
    lines.push(`姓名：${item.name}`);
    lines.push(`电话：${item.phone}`);
    lines.push(`性别：${item.gender}`);
    lines.push(`年龄：${item.age}岁`);
    lines.push(`品牌：${item.brandName}`);
    lines.push(`门店：${item.storeName}`);
    lines.push(`面试岗位：${item.jobName}`);
    lines.push(`面试时间：${item.interviewTime}`);
  }

  return {
    main: lines.join('\n'),
    followUp: '店长们上午好！今天的面试名单请查收~',
  };
}
