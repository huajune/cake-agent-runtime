import { randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { normalizeDashboardPhone } from '../types/dashboard-account';

export interface RosterMember {
  name: string;
  phone: string;
  groupId: string | null;
}

const rosterSchema = z.object({
  members: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        phone: z.string(),
        groupId: z.string().trim().min(1).nullish(),
      }),
    )
    .min(1),
});

/** The private source may contain Sponge and Feishu credentials. Copy only the three identity fields. */
export function parseHenanRoster(source: unknown, requireGroup: boolean): RosterMember[] {
  const parsed = rosterSchema.safeParse(source);
  if (!parsed.success) throw new Error('河南成员名单格式无效');
  const people = new Map<string, RosterMember>();
  const owners = new Map<string, string>();
  for (const { name, phone: raw, groupId } of parsed.data.members) {
    const phone = normalizeDashboardPhone(raw);
    if (!phone) throw new Error('名单中存在无效的手机号');
    const previous = people.get(phone);
    if (
      previous &&
      (previous.name !== name || (previous.groupId && groupId && previous.groupId !== groupId))
    )
      throw new Error('同一手机号对应多个姓名或托管小组，请核对');
    if (groupId) {
      const owner = owners.get(groupId);
      if (owner && owner !== phone) throw new Error('同一托管小组对应多个负责人，请核对');
      owners.set(groupId, phone);
    }
    people.set(phone, { name, phone, groupId: groupId ?? previous?.groupId ?? null });
  }
  const members = [...people.values()];
  if (requireGroup && members.some((m) => !m.groupId))
    throw new Error('发布名单中有成员缺少负责的小组');
  return members;
}

export async function importHenanRoster(
  client: SupabaseClient,
  members: RosterMember[],
): Promise<void> {
  const { error } = await client.rpc('import_dashboard_henan_roster', {
    members: members.map(({ name, phone, groupId }) => ({
      name,
      phone,
      hosting_group_id: groupId,
    })),
  });
  if (error) throw new Error('未导入名单，请核对后台账号迁移和已有成员的小组归属');
}

export interface StaffMember {
  name: string;
  phone: string | null;
  organization: string;
  groupId: string;
  feishuOpenId: string | null;
}

const staffSchema = z.object({
  members: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        phone: z.string().trim().min(1).nullable(),
        groupId: z.string().trim().min(1),
        organization: z.string().trim().min(1),
        feishuOpenId: z.string().trim().min(1).nullish(),
      }),
    )
    .min(1),
});

/** A group has one owner. The phone and configured Feishu identity must also agree across bots. */
export function parseStaffRoster(source: unknown): StaffMember[] {
  const parsed = staffSchema.safeParse(source);
  if (!parsed.success)
    throw new Error('全员名单须包含姓名、组织、小组及手机号，待收集手机号填写 null');
  const groups = new Map<string, StaffMember>();
  const identities = new Map<string, string>();
  for (const row of parsed.data.members) {
    const phone = row.phone ? normalizeDashboardPhone(row.phone) : null;
    if (row.phone && !phone) throw new Error('名单中存在无效的手机号');
    const existing = groups.get(row.groupId);
    if (
      existing &&
      (existing.name !== row.name ||
        existing.organization !== row.organization ||
        (existing.phone && phone && existing.phone !== phone) ||
        (existing.feishuOpenId && row.feishuOpenId && existing.feishuOpenId !== row.feishuOpenId))
    )
      throw new Error('同一托管小组有不同的成员资料');
    for (const identity of [phone, row.feishuOpenId].filter(Boolean)) {
      if (identities.has(identity) && identities.get(identity) !== row.groupId)
        throw new Error('同一成员对应多个小组');
      identities.set(identity, row.groupId);
    }
    groups.set(row.groupId, {
      name: row.name,
      organization: row.organization,
      groupId: row.groupId,
      phone: phone ?? existing?.phone ?? null,
      feishuOpenId: row.feishuOpenId ?? existing?.feishuOpenId ?? null,
    });
  }
  return [...groups.values()];
}

export async function importStaffRoster(
  client: SupabaseClient,
  members: StaffMember[],
  validateOnly = false,
): Promise<void> {
  const { error } = await client.rpc('import_dashboard_staff_roster', {
    validate_only: validateOnly,
    members: members.map((m) => ({
      name: m.name,
      phone: m.phone,
      organization: m.organization,
      hosting_group_id: m.groupId,
      feishu_open_id: m.feishuOpenId,
    })),
  });
  if (error) throw new Error('请核对全员账号迁移及已有成员的手机号、飞书身份和小组归属');
}

/** Atomically publish a complete owner-only file. A retry or concurrent run keeps the first copy. */
export async function writePrivateOnce(path: string, data: unknown): Promise<void> {
  const temp = path + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
    flush: true,
  });
  try {
    await link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temp);
  }
}

export async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
