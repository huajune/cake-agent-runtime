import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');

function readRootEnvValue(mode: string, key: string): string {
  const envFiles = [`.env.local`, `.env.${mode}`, `.env`];

  for (const envFile of envFiles) {
    const envPath = path.resolve(repoRoot, envFile);
    if (!fs.existsSync(envPath)) continue;

    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!match) continue;

    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }

  return '';
}

export default defineConfig(({ mode }) => {
  const apiGuardToken = process.env.API_GUARD_TOKEN || readRootEnvValue(mode, 'API_GUARD_TOKEN');
  const apiProxyTarget =
    process.env.VITE_API_PROXY_TARGET ||
    process.env.API_PROXY_TARGET ||
    `http://localhost:${process.env.PORT || readRootEnvValue(mode, 'PORT') || '8080'}`;
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || readRootEnvValue(mode, 'NEXT_PUBLIC_SUPABASE_URL');
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    readRootEnvValue(mode, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

  return {
    plugins: [react()],
    define: {
      'import.meta.env.API_GUARD_TOKEN': JSON.stringify(apiGuardToken),
      'import.meta.env.SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern',
          additionalData: `@use "${path.resolve(__dirname, './src/assets/styles/_variables.scss')}" as *;`,
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5175, // 使用不同端口避免冲突
      proxy: Object.fromEntries(
        [
          '/agent',
          '/analytics',
          '/config',
          '/strategy',
          '/user',
          '/test-suite',
          '/message',
          '/group',
          '/bot',
          '/feishu',
          '/monitoring',
        ].map((prefix) => [
          prefix,
          { target: apiProxyTarget, changeOrigin: true, timeout: 120000 },
        ]),
      ),
    },
    build: {
      outDir: '../public/web',
      emptyOutDir: true,
      sourcemap: false,
    },
    base: '/web/',
  };
});
