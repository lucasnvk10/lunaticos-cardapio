import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Loading } from "./components/Loading";

const MenuPage = lazy(() => import("./pages/MenuPage").then(module => ({ default: module.MenuPage })));
const OrderPage = lazy(() => import("./pages/OrderPage").then(module => ({ default: module.OrderPage })));
const ActivatePage = lazy(() => import("./pages/ActivatePage").then(module => ({ default: module.ActivatePage })));
const StaffPage = lazy(() => import("./pages/StaffPage").then(module => ({ default: module.StaffPage })));

export function App() {
  return (
    <Suspense fallback={<main className="center-page"><Loading /></main>}>
      <Routes>
        <Route path="/" element={<MenuPage />} />
        <Route path="/pedido/:publicId" element={<OrderPage />} />
        <Route path="/ativar" element={<ActivatePage />} />
        <Route path="/equipe/*" element={<StaffPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
