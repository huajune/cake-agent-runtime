import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from '@/components/Layout';

// View imports - 使用 view/模块/list 目录结构
import Dashboard from '@/view/dashboard/list';
import Logs from '@/view/logs/list';
import ChatRecords from '@/view/chat-records/list';
import System from '@/view/system/list';
import Config from '@/view/config/list';
import Hosting from '@/view/hosting/list';
import Users from '@/view/users/list';
import AgentTest from '@/view/agent-test/list';
import TestSuite from '@/view/test-suite/list';
import Strategy from '@/view/strategy/list';

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
    </>
  );
}

export default App;
