import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { ApiClientError, apiPost } from "../lib/api";

export function ActivatePage() {
  const navigate = useNavigate();
  const token = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "", []);
  const [deviceLabel, setDeviceLabel] = useState("");
  const reader = new URLSearchParams(location.hash.slice(1)).get('reader') === '1';
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await apiPost("/api/staff/activate", { token, deviceLabel, reader, displayName: reader ? deviceLabel : undefined });
      navigate("/equipe", { replace: true });
    } catch (requestError) {
      setError(requestError instanceof ApiClientError ? requestError.message : "Não foi possível ativar este aparelho.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="center-page staff-background">
      <section className="activation-card">
        <Logo />
        <span className="eyebrow">ACESSO DA EQUIPE</span>
        <h1>{reader ? 'Entrar na leitura de QR' : 'Ativar este aparelho'}</h1>
        <p>{reader ? 'Identifique-se com seu nome. Este link libera apenas a leitura de fichas, e registra quem fez cada retirada.' : 'Esta ativação é individual e pode ser revogada pela organização.'}</p>
        <form onSubmit={activate}>
          <label className="field"><span>{reader ? 'Seu nome' : 'Nome do aparelho'}</span><input required minLength={2} maxLength={100} value={deviceLabel} onChange={event => setDeviceLabel(event.target.value)} placeholder={reader ? 'Como você se chama?' : 'Ex.: Bar principal 01'} /></label>
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button primary-button--large" disabled={loading || !token}>{loading ? 'Entrando…' : reader ? 'Entrar na leitura' : 'Ativar aparelho'}</button>
        </form>
        {!token && <div className="error-box">O link de ativação está incompleto.</div>}
      </section>
    </main>
  );
}
