import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import MerchantsPage from "./pages/MerchantsPage";
import NodesPage from "./pages/NodesPage";
import SubscribersPage from "./pages/SubscribersPage";
import SupportPage from "./pages/SupportPage";
import SalesPage from "./pages/SalesPage";
import BroadcastsPage from "./pages/BroadcastsPage";
import PlansPage from "./pages/PlansPage";
import TokenGate from "./components/TokenGate";

const NAV = [
  { to: "/merchants", label: "Мерчанты" },
  { to: "/nodes", label: "Ноды и каскады" },
  { to: "/subscribers", label: "Подписчики" },
  { to: "/support", label: "Поддержка" },
  { to: "/sales", label: "Продажи" },
  { to: "/broadcasts", label: "Рассылки" },
  { to: "/plans", label: "Тарифы" },
];

export default function App() {
  return (
    <TokenGate>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">VPN Admin</div>
          <nav>
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/merchants" replace />} />
            <Route path="/merchants" element={<MerchantsPage />} />
            <Route path="/nodes" element={<NodesPage />} />
            <Route path="/subscribers" element={<SubscribersPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/sales" element={<SalesPage />} />
            <Route path="/broadcasts" element={<BroadcastsPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="*" element={<Navigate to="/merchants" replace />} />
          </Routes>
        </main>
      </div>
    </TokenGate>
  );
}
