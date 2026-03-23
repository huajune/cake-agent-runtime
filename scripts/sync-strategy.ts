import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import { resolve } from 'path';
import {
  DEFAULT_PERSONA,
  DEFAULT_STAGE_GOALS,
  DEFAULT_RED_LINES,
} from '../src/types/strategy-config.types';

// 手动解析 .env.local
const envPath = resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const match = line.match(/^([^#]+?)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim();
    }
  });
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function syncConfig() {
  console.log('正在连接 Supabase...');
  
  // 1. 查找当前激活的配置
  const { data: config, error: fetchError } = await supabase
    .from('strategy_config')
    .select('id')
    .eq('is_active', true)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    console.error('读取策略配置失败:', fetchError);
    return;
  }

  if (config) {
    console.log(`找到活跃配置 (ID: ${config.id})，正在覆盖最新策略...`);
    const { error: updateError } = await supabase
      .from('strategy_config')
      .update({
        persona: DEFAULT_PERSONA,
        stage_goals: DEFAULT_STAGE_GOALS,
        red_lines: DEFAULT_RED_LINES,
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id);

    if (updateError) {
      console.error('配置同步到数据库失败:', updateError);
    } else {
      console.log('✅ 策略配置同步成功！数据库已被更新为最新的本地代码版本。');
    }
  } else {
    console.log('数据库里还没有策略记录，下次服务读取时这套代码将自动作为默认值写入种子数据。');
  }
}

syncConfig();
