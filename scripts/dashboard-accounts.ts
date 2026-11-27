/** Trusted setup for the dedicated administrator and employee profiles. */
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { initializeDashboardAdministrator } from '../src/cli/dashboard-administrator';
import {
  importHenanRoster,
  parseHenanRoster,
  importStaffRoster,
  parseStaffRoster,
} from '../src/cli/dashboard-roster';

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('请显式加载目标环境的 Supabase 配置');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [command, source] = process.argv.slice(2);
  if (command === 'import-staff' && source) {
    const members = parseStaffRoster(JSON.parse(await readFile(source, 'utf8')));
    await importStaffRoster(client, members);
    process.stdout.write(`已核对 ${members.length} 位成员档案。\n`);
    return;
  }
  if (command === 'import-henan' && source) {
    const members = parseHenanRoster(JSON.parse(await readFile(source, 'utf8')), false);
    await importHenanRoster(client, members);
    process.stdout.write(`已核对 ${members.length} 位成员及其小组，已有账号保持原有状态。\n`);
    return;
  }
  if (command !== 'bootstrap' || !source)
    throw new Error(
      '请选择 bootstrap <私有目录>、import-staff <名单路径> 或 import-henan <河南旧名单路径>',
    );
  await initializeDashboardAdministrator(client, source, new URL(url).origin);
  process.stdout.write('专用管理员 cakeadmin 已就绪。初次开通的密码由办理人私下领取。\n');
}
main().catch((err: Error) => {
  process.stderr.write(err.message + '\n');
  process.exitCode = 1;
});
