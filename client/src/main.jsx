import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import './styles/base.css';
import { applyTheme, getStoredTheme } from './lib/theme.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { classify } from './lib/errors.js';
// Statically bundled on purpose: it must render even when lazy chunks fail.
import ErrorPage from './pages/ErrorPage.jsx';

// Apply the saved theme before first paint (no light flash in dark mode).
applyTheme(getStoredTheme());

// Route-level code splitting: the dashboard never downloads three.js,
// and the landing page never downloads the dashboard.
const Landing = lazy(() => import('./pages/Landing.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const AppLayout = lazy(() => import('./layout/AppLayout.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const AiPage = lazy(() => import('./pages/AiPage.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));

function ModuleLoader() {
  return (
    <div className="module-loader" role="status">
      <span className="spin-square" aria-hidden />
      <span>loading module</span>
    </div>
  );
}

function PageLoader() {
  return (
    <div className="page-loader mono" role="status">
      <span className="spin-square" aria-hidden /> loading section
    </div>
  );
}

const page = (el) => <Suspense fallback={<PageLoader />}>{el}</Suspense>;

/** Last line of defence: any uncaught render error shows the error page, not a blank screen. */
function RootBoundary({ children }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary
      resetKey={pathname}
      fallback={({ error, componentStack, reset }) => (
        <ErrorPage kind={classify(error)} error={error} componentStack={componentStack} onRetry={reset} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <RootBoundary>
      <Suspense fallback={<ModuleLoader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<AppLayout />}>
            <Route index element={page(<Dashboard />)} />
            <Route path="ai" element={page(<AiPage />)} />
            <Route path="reports" element={page(<Reports />)} />
            <Route path="reports/:month" element={page(<Reports />)} />
            <Route path="*" element={<ErrorPage kind="notfound" embedded />} />
          </Route>
          <Route path="*" element={<ErrorPage kind="notfound" />} />
        </Routes>
      </Suspense>
      </RootBoundary>
    </BrowserRouter>
  </StrictMode>,
);
