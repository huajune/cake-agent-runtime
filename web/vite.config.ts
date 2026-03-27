import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiGuardToken = process.env.API_GUARD_TOKEN || env.API_GUARD_TOKEN || '';

  return {
    envDir: repoRoot,
    plugins: [react()],
    define: {
      'import.meta.env.API_GUARD_TOKEN': JSON.stringify(apiGuardToken),
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
        ['/agent', '/analytics', '/config', '/strategy', '/user', '/test-suite', '/message', '/group', '/feishu', '/monitoring'].map(
          (prefix) => [prefix, { target: 'http://localhost:8080', changeOrigin: true, timeout: 120000 }],
        ),
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
