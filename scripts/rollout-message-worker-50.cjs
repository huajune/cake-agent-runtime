// 在通过健康检查的新生产容器内执行。只访问本机 API，部署流程在核验成功后记录已执行。
const { setTimeout: sleep } = require('node:timers/promises');

async function request(path, options) {
  if (!process.env.CAKE_MACHINE_API_TOKEN) throw new Error('缺少本机 API 认证');
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8585}/message/${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${process.env.CAKE_MACHINE_API_TOKEN}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  const result = await response.json();
  if (result.success === false) throw new Error(result.message || `${path} 失败`);
  return result.data ?? result;
}

async function applyWorkerConcurrency(call = request, wait = sleep) {
  let status = await call('worker-status');
  if (status.maxConcurrency !== 100 || !Number.isInteger(status.registeredConcurrency)) {
    throw new Error('运行版本尚未支持 100 个槽及 Bull 注册状态');
  }
  if (status.concurrency !== 50) {
    await call('worker-concurrency', { method: 'POST', body: JSON.stringify({ concurrency: 50 }) });
  }
  const until = Date.now() + 5 * 60_000;
  do {
    status = await call('worker-status');
    if (status.concurrency !== 50) throw new Error(`配置已变更为 ${status.concurrency}，请核对`);
    if (status.registeredConcurrency === 50) {
      console.log('生产 Worker 配置 50，Bull 已注册 50，单实例上限 100。');
      return;
    }
    await wait(2000);
  } while (Date.now() < until);
  throw new Error(
    `等待 Bull 注册超时，配置 ${status.concurrency}，已注册 ${status.registeredConcurrency}，处理中 ${status.activeJobs}`,
  );
}

module.exports = { applyWorkerConcurrency };

if (require.main === module || process.argv[1] === '-') {
  applyWorkerConcurrency().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
