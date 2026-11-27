import { randomBytes, randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { dashboardPasswordSchema } from '../infra/server/dashboard-access/dashboard-password.schema';
import {
  DASHBOARD_ADMIN_EMAIL,
  DASHBOARD_ADMIN_LOGIN,
  isConfirmedDashboardAdminUser,
} from '../types/dashboard-account';
import { readPrivateJson, writePrivateOnce } from './dashboard-roster';

const batchSchema = z.object({
  project: z.string(),
  id: z.uuid(),
  password: dashboardPasswordSchema,
});

export async function readDashboardAdministrator(client: SupabaseClient): Promise<User | null> {
  const { data: row, error } = await client
    .from('tenant_members')
    .select('user_id,disabled,organization')
    .eq('login_name', DASHBOARD_ADMIN_LOGIN)
    .maybeSingle();
  if (error) throw new Error('请核对管理员账号迁移');
  if (!row) return null;
  if (row.disabled || row.organization !== 'headquarters' || !row.user_id)
    throw new Error('专用管理员账号状态异常，请通过受信任的运维终端核对');
  const auth = await client.auth.admin.getUserById(row.user_id);
  if (auth.error || !auth.data.user || !isConfirmedDashboardAdminUser(auth.data.user))
    throw new Error('专用管理员的 Auth 身份不一致');
  return auth.data.user;
}

/** Hand off the prepared password only when this batch created the Auth account. */
export async function initializeDashboardAdministrator(
  client: SupabaseClient,
  directory: string,
  project: string,
): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('管理员开户目录权限须为 0700');
  const working = join(directory, 'cakeadmin.work.json');
  let batch: z.infer<typeof batchSchema> | undefined;
  try {
    batch = batchSchema.parse(await readPrivateJson(working));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let user = await readDashboardAdministrator(client);
  if (!user && !batch) {
    await writePrivateOnce(working, {
      project,
      id: randomUUID(),
      password: 'Aa1!' + randomBytes(24).toString('base64url'),
    });
    batch = batchSchema.parse(await readPrivateJson(working));
  }
  if (batch && batch.project !== project) throw new Error('管理员开户批次与目标项目不一致');
  if (!user && batch) {
    await client.auth.admin.createUser({
      email: DASHBOARD_ADMIN_EMAIL,
      email_confirm: true,
      password: batch.password,
      app_metadata: {
        cake_dashboard_account: {
          login_name: DASHBOARD_ADMIN_LOGIN,
          organization: 'headquarters',
          initialization_id: batch.id,
        },
      },
    });
    user = await readDashboardAdministrator(client);
  }
  if (!user) throw new Error('管理员开户未完成，请核对认证设置及专用账号标识');
  if (batch && user.app_metadata.cake_dashboard_account.initialization_id === batch.id) {
    const file = join(directory, 'cakeadmin.private.json');
    const credentials = { login: DASHBOARD_ADMIN_LOGIN, password: batch.password };
    await writePrivateOnce(file, credentials);
    if (!isDeepStrictEqual(await readPrivateJson(file), credentials))
      throw new Error('管理员密码交付文件与本批开户不一致');
  }
  const receipt = { project, userId: user.id, login: DASHBOARD_ADMIN_LOGIN };
  const receiptPath = join(directory, 'cakeadmin.ready.json');
  await writePrivateOnce(receiptPath, receipt);
  if (!isDeepStrictEqual(await readPrivateJson(receiptPath), receipt))
    throw new Error('管理员开户回执与当前身份不一致');
  if (batch) await rm(working, { force: true });
}
