/** One-time release job. The only durable cleartext credentials live in the private handoff directory. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readGroupDirectory } from '../channels/wecom/group/read-group-directory';
import { readBotDirectory } from '../channels/wecom/bot/read-bot-directory';
import { STRIDE_PRIMARY_CONNECTION } from '../types/hosting-route';
import {
  initializeDashboardAdministrator,
  readDashboardAdministrator,
} from './dashboard-administrator';
import { DASHBOARD_ADMIN_LOGIN, normalizeDashboardPhone } from '../types/dashboard-account';
import { DEFAULT_HENAN_GROUP_MARKER, hostingGroupOrganization } from '../types/hosting-group';
import {
  importStaffRoster,
  parseStaffRoster,
  readPrivateJson,
  writePrivateOnce,
  type StaffMember,
} from './dashboard-roster';

const columns = 'phone,name,organization,user_id,disabled,hosting_group_id';
const workFile = 'credentials.work.json';
const stateSchema = z.object({
  fingerprint: z.string(),
  batchId: z.uuid(),
  passwords: z.record(z.string(), z.string().min(24)),
});

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('开户目录须仅对办理人开放，请将目录权限设为 0700');
}

async function readBatchState(file: string, fingerprint: string, members: StaffMember[]) {
  const state = stateSchema.parse(await readPrivateJson(file));
  if (state.fingerprint !== fingerprint || members.some((m) => !state.passwords[m.phone]))
    throw new Error('已有开户批次与本次名单不一致');
  return state;
}
function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error('缺少环境配置 ' + key);
  return value;
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function prepare(source: string, directory: string, projectUrl: string): Promise<void> {
  const members = parseStaffRoster(await readPrivateJson(source));
  const manifest = { version: 2, projectUrl, members };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await verifyPrivateDirectory(directory);
  const file = join(directory, 'roster.json');
  await writePrivateOnce(file, manifest);
  if (!isDeepStrictEqual(await readPrivateJson(file), manifest))
    throw new Error('目标位置已有不同的名单');
  process.stdout.write(`已准备 ${members.length} 位成员及其小组。\n`);
}

async function readConfirmedDirectory(members: StaffMember[]) {
  const base = required('STRIDE_ENTERPRISE_API_BASE_URL').replace(/\/+$/, '');
  const token = required('STRIDE_ENTERPRISE_TOKEN');
  const groups = await readGroupDirectory(async (current, size) => {
    const url = new URL(base + '/api/v2/group/list');
    url.search = new URLSearchParams({
      token,
      current: String(current),
      pageSize: String(size),
    }).toString();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Stride 小组目录读取失败');
    return response.json();
  });
  const marker = (process.env.HENAN_GROUP_DESCRIPTION_MARKER ?? DEFAULT_HENAN_GROUP_MARKER).trim();
  const organizations = new Map(
    groups.map((group) => [group.id, hostingGroupOrganization(group.description, marker)]),
  );
  if (members.some((member) => organizations.get(member.groupId) !== member.organization))
    throw new Error('负责小组的当前组织与开户名单不一致，请核对 Stride 归属');
  const url = new URL(base + '/api/v1/bot/getGroupBots');
  url.searchParams.set('token', token);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Stride 托管号目录读取失败');
  const botGroups = readBotDirectory(await response.json(), true);
  const botsByGroup = new Map(
    botGroups.map((group) => [group.id, group.bots?.map((bot) => bot.wxid)]),
  );
  return members.map((member) => ({
    group_id: member.groupId,
    tenant_id: member.organization,
    bot_im_ids: botsByGroup.get(member.groupId) ?? [],
  }));
}
async function preflight(
  client: SupabaseClient,
  members: StaffMember[],
  project: string,
): Promise<void> {
  const [settings] = await Promise.all([
    fetch(project + '/auth/v1/settings', {
      headers: { apikey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY') },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }),
    ...(members.length ? [importStaffRoster(client, members, true)] : []),
    readDashboardAdministrator(client),
  ]);
  if (!settings.ok) throw new Error('无法核对 Supabase 登录设置');
  const config = await settings.json();
  if (!config.external?.email || !config.external?.phone || config.disable_signup !== true)
    throw new Error('请在目标 Supabase 启用 Email 和 Phone 密码认证并关闭自助注册');
}
async function getMember(client: SupabaseClient, member: StaffMember) {
  const { data, error } = await client
    .from('dashboard_accounts')
    .select(columns)
    .eq('phone', member.phone)
    .single();
  if (
    error ||
    !data ||
    data.organization !== member.organization ||
    data.name !== member.name ||
    (!data.disabled && data.hosting_group_id !== member.groupId)
  )
    throw new Error('成员归属发生变化，请核对');
  return data;
}

export async function activateStaffAccounts(
  client: SupabaseClient,
  directory: string,
  members: StaffMember[],
  fingerprint: string,
): Promise<void> {
  const ready = members.filter((member) => member.phone);
  const pending = members.length - ready.length;
  const working = join(directory, workFile);
  if (!(await exists(working))) {
    const passwords = Object.fromEntries(
      ready.map((m) => [m.phone, 'Aa1!' + randomBytes(24).toString('base64url')]),
    );
    await writePrivateOnce(working, { fingerprint, batchId: randomUUID(), passwords });
  }
  const state = await readBatchState(working, fingerprint, ready);
  await importStaffRoster(client, members);
  const handoff: Array<StaffMember & { password: string }> = [];
  let existing = 0;
  let disabled = 0;
  for (const member of ready) {
    let row = await getMember(client, member);
    if (!row.disabled && !row.user_id) {
      const result = await client.auth.admin.createUser({
        phone: member.phone,
        password: state.passwords[member.phone],
        phone_confirm: true,
        app_metadata: {
          cake_dashboard_account: {
            name: member.name,
            organization: member.organization,
            initialization_id: state.batchId,
          },
        },
      });
      // A repeat request may arrive after the original Auth transaction has already committed.
      row = await getMember(client, member);
      if (!row.user_id && !row.disabled)
        throw new Error(
          '开户未完成，请核对已有 Auth 手机号后重试。错误代码 ' +
            (result.error?.code ?? 'binding_missing'),
        );
    }
    if (row.disabled) {
      disabled++;
      continue;
    }
    const { data, error } = await client.auth.admin.getUserById(row.user_id);
    if (
      error ||
      !data.user?.phone ||
      !data.user.phone_confirmed_at ||
      normalizeDashboardPhone('+' + data.user.phone.replace(/^\+/, '')) !== member.phone
    )
      throw new Error('Auth 身份与手机号未能核对');
    if (data.user.app_metadata.cake_dashboard_account?.initialization_id === state.batchId)
      handoff.push({ ...member, password: state.passwords[member.phone] });
    else existing++;
  }
  const delivery = { batchId: state.batchId, members: handoff };
  const output = join(directory, 'handoff.private.json');
  await writePrivateOnce(output, delivery);
  if (!isDeepStrictEqual(await readPrivateJson(output), delivery))
    throw new Error('私下交付文件与已核对账号不符');
  const receipt = { fingerprint, created: handoff.length, existing, disabled, pending };
  await writePrivateOnce(join(directory, 'complete.json'), receipt);
  await rm(working, { force: true });
  process.stdout.write(
    `开户完成，新开 ${handoff.length}，沿用 ${existing}，已停用 ${disabled}，待补手机号 ${pending}。\n`,
  );
}

async function main(): Promise<void> {
  const [action, directory, source] = process.argv.slice(2);
  if (!directory || !['prepare', 'check', 'apply'].includes(action))
    throw new Error('请选择 prepare <私有目录> <名单>、check <私有目录> 或 apply <私有目录>');
  const project = new URL(required('NEXT_PUBLIC_SUPABASE_URL')).origin;
  if (action === 'prepare') {
    if (!source) throw new Error('缺少原始成员名单');
    await prepare(source, directory, project);
    return;
  }
  await verifyPrivateDirectory(directory);
  const raw = await readPrivateJson(join(directory, 'roster.json'));
  const manifest = z.object({ version: z.literal(2), projectUrl: z.string() }).parse(raw);
  if (project !== manifest.projectUrl) throw new Error('名单与目标 Supabase 项目不一致');
  const members = parseStaffRoster(raw);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([project, members]))
    .digest('hex');
  const receipt = join(directory, 'complete.json');
  const staffComplete = await exists(receipt);
  const client = createClient(project, required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ownershipReceipt = join(directory, 'tenant-directory.ready.json');
  const expectedOwnership = { project, fingerprint };
  const directoryReady = await exists(ownershipReceipt);
  if (
    directoryReady &&
    !isDeepStrictEqual(await readPrivateJson(ownershipReceipt), expectedOwnership)
  )
    throw new Error('租户归属回执与当前项目或名单不一致');
  if (staffComplete) {
    if (
      z.object({ fingerprint: z.string() }).parse(await readPrivateJson(receipt)).fingerprint !==
      fingerprint
    )
      throw new Error('目标位置已有不同批次的完成记录');
    const adminReceipt = join(directory, 'cakeadmin.ready.json');
    if ((await exists(adminReceipt)) && !(await exists(join(directory, 'cakeadmin.work.json')))) {
      const ready = z.object({
        project: z.literal(project),
        login: z.literal(DASHBOARD_ADMIN_LOGIN),
        userId: z.uuid(),
      });
      if (!ready.safeParse(await readPrivateJson(adminReceipt)).success)
        throw new Error('管理员开户回执与目标项目不一致');
      if (directoryReady) {
        if (action === 'apply') await rm(join(directory, workFile), { force: true });
        process.stdout.write('管理员、本批员工账号及托管归属已就绪。\n');
        return;
      }
    }
  }
  await preflight(client, staffComplete ? [] : members, project);
  if (!directoryReady) {
    const { error } = await client.rpc('register_hosting_directory', {
      p_connection_id: STRIDE_PRIMARY_CONNECTION,
      p_groups: await readConfirmedDirectory(members),
      p_check_only: action === 'check',
    });
    if (error) throw new Error('托管小组或 Bot 的租户绑定无法确认，请核对归属与交接时间');
    if (action === 'apply') await writePrivateOnce(ownershipReceipt, expectedOwnership);
  }
  if (action === 'check') {
    const working = join(directory, workFile);
    if (await exists(working))
      await readBatchState(
        working,
        fingerprint,
        members.filter((m) => m.phone),
      );
    process.stdout.write(`开户预检通过，共 ${members.length} 位成员。\n`);
    return;
  }
  await initializeDashboardAdministrator(client, directory, project);
  if (staffComplete) {
    await rm(join(directory, workFile), { force: true });
    process.stdout.write('管理员及本批员工账号已就绪。\n');
    return;
  }
  await activateStaffAccounts(client, directory, members, fingerprint);
}

if (require.main === module)
  main().catch((error: Error) => {
    // SDK/JSON parse details may contain supplied values.
    process.stderr.write(
      (error.constructor === Error ? error.message : '无法完成开户，请核对输入和外部服务') + '\n',
    );
    process.exitCode = 1;
  });
