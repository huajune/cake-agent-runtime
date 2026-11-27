import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import logo from '@/assets/images/cake_recruiter_icon.png';
import { changeDashboardPassword, dashboardAuth } from '@/api/dashboard-session';
import { dashboardLoginIdentity } from '@/api/dashboard-accounts';
import styles from './styles/index.module.scss';

export default function Login({ onSignedIn }: { onSignedIn: (userId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const [changing, setChanging] = useState(false);

  function switchForm(change: boolean) {
    setChanging(change);
    setVisible(false);
    setError('');
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dashboardAuth) return;
    const form = new FormData(event.currentTarget);
    const identity = dashboardLoginIdentity(String(form.get('login') ?? ''));
    if (!identity) {
      setError('请输入有效的手机号或管理员账号');
      return;
    }
    const current = String(form.get('password') ?? '');
    const next = String(form.get('new-password') ?? '');
    if (changing) {
      if (next.length < 8 || new TextEncoder().encode(next).length > 72) {
        setError('新密码至少 8 个字符，最多 72 字节');
        return;
      }
      if (current === next || next !== form.get('confirmation')) {
        setError(current === next ? '新密码须与当前密码不同' : '两次输入的新密码不一致');
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      if (changing) {
        await changeDashboardPassword(identity, current, next);
        switchForm(false);
        toast.success('密码已修改，请用新密码登录');
        return;
      }
      const result = await dashboardAuth.signInWithPassword({
        ...identity,
        password: current,
      });
      if (result.error) {
        setError(
          result.error.status === 429
            ? '尝试次数较多，请稍后再试'
            : '登录失败，请检查账号和密码，或联系管理员',
        );
      } else if (result.data.user) {
        onSignedIn(result.data.user.id);
      }
    } catch (cause) {
      setError(
        changing && cause instanceof Error && !(cause instanceof TypeError)
          ? cause.message
          : '暂时无法连接登录服务，请稍后再试',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section
        className={styles.card}
        aria-labelledby="login-title"
        aria-describedby="login-description"
      >
        <header className={styles.brand}>
          <img src={logo} width={44} height={44} alt="" />
          <span>蛋糕私域</span>
          <span className={styles.workspaceTag} lang="en">
            AI Workspace
          </span>
        </header>
        <hgroup className={styles.intro}>
          <h1 id="login-title">{changing ? '修改密码' : '欢迎回来'}</h1>
          <p id="login-description">
            {changing ? '输入当前密码，为您的账号设置新密码' : '登录以管理您的智能托管与客户资产'}
          </p>
        </hgroup>
        <form onSubmit={login} className={styles.form}>
          <label htmlFor="login">账号</label>
          <input
            id="login"
            name="login"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="手机号 / 管理员账号"
            required
          />
          <label htmlFor="password">{changing ? '当前密码' : '密码'}</label>
          <div className={styles.password} key={changing ? 'change' : 'login'}>
            <input
              id="password"
              name="password"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder={changing ? '输入当前密码' : '输入密码'}
              required
            />
            <button
              type="button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? '隐藏密码' : '显示密码'}
              aria-pressed={visible}
            >
              {visible ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {changing && (
            <>
              <label htmlFor="new-password">新密码</label>
              <input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 个字符"
                minLength={8}
                required
              />
              <label htmlFor="confirmation">确认新密码</label>
              <input
                id="confirmation"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                placeholder="再次输入新密码"
                required
              />
            </>
          )}
          {(error || !dashboardAuth) && (
            <p role="alert">{error || '登录服务尚未配置，请联系总部'}</p>
          )}
          <button type="submit" className={styles.submit} disabled={busy || !dashboardAuth}>
            {changing ? (
              busy ? (
                '正在保存…'
              ) : (
                '保存新密码'
              )
            ) : busy ? (
              '正在登录…'
            ) : (
              <>
                进入工作台{' '}
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              </>
            )}
          </button>
        </form>
        <footer>
          <span>
            {changing ? '忘记当前密码？联系管理员' : '需要开通权限或重置密码？联系管理员'}
          </span>
          <button type="button" disabled={busy} onClick={() => switchForm(!changing)}>
            {changing ? '返回登录' : '修改密码'}
          </button>
        </footer>
      </section>
    </main>
  );
}
