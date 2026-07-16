import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import NodesPage from "./pages/NodesPage";
import SubscribersPage from "./pages/SubscribersPage";

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">VPN Admin</div>
        <nav>
          <NavLink to="/nodes">Ноды</NavLink>
          <NavLink to="/subscribers">Подписчики</NavLink>
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/nodes" replace />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/subscribers" element={<SubscribersPage />} />
        </Routes>
      </main>
    </div>
  );
}
