import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import logo from '@/assets/images/cake_recruiter_icon.png';
import { dashboardAuth } from '@/api/dashboard-session';
import { dashboardLoginIdentity } from '@/api/dashboard-accounts';
import styles from './styles/index.module.scss';

export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dashboardAuth) return;
    const form = new FormData(event.currentTarget);
    const identity = dashboardLoginIdentity(String(form.get('login') ?? ''));
    if (!identity) {
      setError('请输入有效的手机号或管理员账号');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await dashboardAuth.signInWithPassword({
        ...identity,
        password: String(form.get('password') ?? ''),
      });
      if (result.error)
        setError(
          result.error.status === 429
            ? '尝试次数较多，请稍后再试'
            : '登录失败，请检查账号和密码，或联系管理员',
        );
    } catch {
      setError('暂时无法连接登录服务，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.brand}>
          <img src={logo} alt="" />
          蛋糕私域托管
        </div>
        <h1 id="login-title">登录管理后台</h1>
        <form onSubmit={login} className={styles.form}>
          <label htmlFor="login">手机号或管理员账号</label>
          <input
            id="login"
            name="login"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="请输入登录账号"
            required
          />
          <label htmlFor="password">密码</label>
          <div className={styles.password}>
            <input
              id="password"
              name="password"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="请输入密码"
              required
            />
            <button
              type="button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? '隐藏密码' : '显示密码'}
            >
              {visible ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {(error || !dashboardAuth) && (
            <p role="alert">{error || '登录服务尚未配置，请联系总部'}</p>
          )}
          <button type="submit" className={styles.submit} disabled={busy || !dashboardAuth}>
            {busy ? '正在登录…' : '登录'}
          </button>
        </form>
        <small>开通账号或重置密码，请联系管理员。</small>
      </section>
    </main>
  );
}
