import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from '@/components/Layout';
import {
  AgentTest,
  ChatRecords,
  Config,
  ConversionAnalysis,
  Dashboard,
  Hosting,
  MessageProcessing,
  Reengagement,
  Strategy,
  System,
  TestSuite,
  Users,
} from '@/routes/lazy-pages';

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
            border: '1px solid rgba(138, 137, 173, 0.2)',
            borderRadius: '12px',
            padding: '12px 16px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
            fontSize: '14px',
            color: '#14132b',
          },
          success: {
            iconTheme: { primary: '#5ec9a0', secondary: '#fff' },
          },
          error: {
            iconTheme: { primary: '#f07ea3', secondary: '#fff' },
          },
        }}
      />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="conversion-analysis" element={<ConversionAnalysis />} />
          <Route path="users" element={<Users />} />
          <Route path="hosting" element={<Hosting />} />
          <Route path="config" element={<Config />} />
          <Route path="system" element={<System />} />
          <Route path="message-processing" element={<MessageProcessing />} />
          <Route path="reengagement" element={<Reengagement />} />
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
