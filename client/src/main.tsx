import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, Link, useLocation } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { Login } from "./screens/Login";
import { Monitors } from "./screens/Monitors";
import { NewMonitor } from "./screens/NewMonitor";
import { MonitorDetail } from "./screens/MonitorDetail";
import { Account } from "./screens/Account";

function Shell() {
  const { user } = useAuth();
  const loc = useLocation();
  return (
    <div className="app">
      <header className="header">
        <Link to="/" className="brand">
          Page Monitor
        </Link>
        <nav>{user && loc.pathname !== "/account" ? <Link to="/account">account</Link> : null}</nav>
      </header>
      <Outlet />
    </div>
  );
}

function Private() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <Outlet />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/login" element={<Login />} />
            <Route element={<Private />}>
              <Route path="/" element={<Monitors />} />
              <Route path="/new" element={<NewMonitor />} />
              <Route path="/m/:id" element={<MonitorDetail />} />
              <Route path="/account" element={<Account />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
