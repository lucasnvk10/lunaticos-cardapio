import { Link } from "react-router-dom";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="brand-link" aria-label="Voltar ao cardápio da Lunáticos" onClick={() => {
      if (window.location.pathname === "/") window.scrollTo({ top: 0, behavior: "smooth" });
    }}>
      <span className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand__logo-frame">
        <img className="brand__logo" src="/brand/lunaticos-ufpr.png" alt="Lunáticos UFPR" />
      </span>
      {!compact && <span className="brand__tag">fichas digitais</span>}
      </span>
    </Link>
  );
}
