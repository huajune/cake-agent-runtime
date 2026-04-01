import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from '@/components/Layout';

// Route-level lazy loading keeps the initial dashboard bundle smaller.
const Dashboard = lazy(() => import('@/view/dashboard/list'));
const Logs = lazy(() => import('@/view/logs/list'));
const ChatRecords = lazy(() => import('@/view/chat-records/list'));
const System = lazy(() => import('@/view/system/list'));
const Config = lazy(() => import('@/view/config/list'));
const Hosting = lazy(() => import('@/view/hosting/list'));
const Users = lazy(() => import('@/view/users/list'));
const AgentTest = lazy(() => import('@/view/agent-test/list'));
const TestSuite = lazy(() => import('@/view/test-suite/list'));
const Strategy = lazy(() => import('@/view/strategy/list'));

function App() {
  return (
    <>
      <Toaster
        position="top-center"
        containerStyle={{ top: '50%', transform: 'translateY(-50%)' }}
        toastOptions={{
          duration: 2000,
          style: {
            background: 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            borderRadius: '12px',
            padding: '12px 16px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
            fontSize: '14px',
            color: '#1e293b',
          },
          success: {
            iconTheme: { primary: '#10b981', secondary: '#fff' },
          },
          error: {
            iconTheme: { primary: '#ef4444', secondary: '#fff' },
          },
        }}
      />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="hosting" element={<Hosting />} />
            <Route path="config" element={<Config />} />
            <Route path="system" element={<System />} />
            <Route path="logs" element={<Logs />} />
            <Route path="chat-records" element={<ChatRecords />} />
            <Route path="agent-test" element={<AgentTest />} />
            <Route path="test-suite" element={<TestSuite />} />
            <Route path="strategy" element={<Strategy />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}

export default App;
