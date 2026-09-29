import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { Logo } from "../components/Logo";
import { Loading } from "../components/Loading";
import { ApiClientError, apiGet, apiPost, formatDate, money } from "../lib/api";
import type { OrderTicket, OrderView } from "../lib/types";

function readToken(): string {
  const params = new URLSearchParams(location.hash.slice(1));
  return params.get("token") ?? "";
}

function TicketCard({ ticket, position, total }: { ticket: OrderTicket; position: number; total: number }) {
  const [qrImage, setQrImage] = useState("");
  useEffect(() => {
    QRCode.toDataURL(`eventticket:${ticket.token}`, { width: 320, margin: 2, color: { dark: "#17110dff", light: "#ffffffff" } }).then(setQrImage);
  }, [ticket.token]);
  return (
    <article className={`ticket-card ticket-card--${ticket.status.toLowerCase()}`}>
      <div className="ticket-card__top"><span>FICHA {position} DE {total}</span><b>{ticket.status === "AVAILABLE" ? "Disponível" : ticket.status === "USED" ? "Utilizada" : "Cancelada"}</b></div>
      <div className="ticket-card__product"><span>🍹</span><div><small>RETIRADA NO BAR</small><h2>{ticket.productName}</h2></div></div>
      <div className="ticket-card__qr">{qrImage ? <img src={qrImage} alt={`QR da ficha de ${ticket.productName}`} /> : <Loading label="Gerando QR" />}{ticket.status !== "AVAILABLE" && <div className="ticket-card__stamp">{ticket.status === "USED" ? "UTILIZADA" : "CANCELADA"}</div>}</div>
      <p>{ticket.status === "AVAILABLE" ? "Mostre este QR ao atendente. Cada ficha vale uma retirada." : ticket.usedAt ? `Retirada registrada em ${formatDate(ticket.usedAt)}` : "Esta ficha não pode mais ser utilizada."}</p>
    </article>
  );
}

export function OrderPage() {
  const { publicId = "" } = useParams();
  const token = useMemo(readToken, []);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copyLabel, setCopyLabel] = useState("Copiar código Pix");
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  const loadOrder = useCallback(async (refresh = false) => {
    if (!token) { setError("O link privado está incompleto."); setLoading(false); return; }
    try {
      const options = { headers: { Authorization: `Bearer ${token}` } };
      const result = refresh
        ? await apiPost<OrderView>(`/api/orders/${publicId}/refresh`, undefined, options)
        : await apiGet<OrderView>(`/api/orders/${publicId}`, options);
      setOrder(result);
      setError("");
      localStorage.setItem("last-event-order", `/pedido/${publicId}#token=${token}`);
    } catch (requestError) {
      setError(requestError instanceof ApiClientError ? requestError.message : "Não foi possível carregar o pedido.");
    } finally {
      setLoading(false);
    }
  }, [publicId, token]);

  useEffect(() => { void loadOrder(); }, [loadOrder]);
  useEffect(() => {
    if (!order?.expiresAt || order.status !== "PENDING_PAYMENT") return;
    const update = () => setRemainingSeconds(Math.max(0, Math.floor((new Date(order.expiresAt!).getTime() - Date.now()) / 1000)));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [order?.expiresAt, order?.status]);
  useEffect(() => {
    if (order?.status !== "PENDING_PAYMENT") return;
    const startedAt = Date.now();
    let timeoutId = 0;
    const poll = async () => {
      if (document.visibilityState === "visible") await loadOrder(true);
      const elapsed = Date.now() - startedAt;
      timeoutId = window.setTimeout(poll, elapsed < 120_000 ? 10_000 : 30_000);
    };
    timeoutId = window.setTimeout(poll, 10_000);
    return () => window.clearTimeout(timeoutId);
  }, [order?.status, loadOrder]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "visible" && order?.status === "PAID") void loadOrder(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [order?.status, loadOrder]);

  async function copyPix() {
    if (!order?.pixCode) return;
    await navigator.clipboard.writeText(order.pixCode);
    setCopyLabel("Código copiado ✓");
    window.setTimeout(() => setCopyLabel("Copiar código Pix"), 2000);
  }

  async function shareOrder() {
    const url = location.href;
    if (navigator.share) await navigator.share({ title: "Meu pedido", text: "Salve este link para acessar suas fichas", url });
    else await navigator.clipboard.writeText(url);
  }

  if (loading) return <main className="center-page"><Loading label="Buscando seu pedido" /></main>;
  if (!order || error) return <main className="center-page"><div className="state-card"><span>⚠</span><h1>Não encontramos o pedido</h1><p>{error}</p><a className="primary-button" href="/">Voltar ao cardápio</a></div></main>;

  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
  return (
    <main className="order-page">
      <header className="topbar"><Logo compact /><div className="order-topbar-actions"><a className="secondary-button" href="/">← Voltar ao cardápio</a><button type="button" className="ghost-button" onClick={shareOrder}>Salvar link</button></div></header>
      {order.status === "PENDING_PAYMENT" && (
        <section className="payment-panel">
          <span className="eyebrow">PEDIDO {order.publicId.replace("pedido_", "#").toUpperCase()}</span>
          <h1>Finalize seu Pix</h1>
          <p>Suas bebidas estão reservadas enquanto o cronômetro estiver ativo.</p>
          <div className="timer"><span>Reserva termina em</span><strong>{minutes}:{seconds}</strong></div>
          <div className="pix-card">
            <div className="pix-card__qr">{order.pixCode && <PixQr code={order.pixCode} />}</div>
            <div className="pix-card__info"><small>VALOR DO PEDIDO</small><strong>{money(order.amountCents)}</strong><p>Escaneie no aplicativo do seu banco ou use o código copia e cola.</p><button className="primary-button" type="button" onClick={copyPix}>{copyLabel}</button></div>
          </div>
          <button className="refresh-button" type="button" onClick={() => loadOrder(true)}>Já paguei, verificar agora</button>
          <div className="pending-status"><i /><span>Aguardando confirmação do PagBank</span></div>
        </section>
      )}
      {order.status === "PAID" && (
        <section className="tickets-section">
          <div className="success-heading"><span>✓</span><div><small>{order.kind === "COURTESY" ? "CORTESIA LIBERADA" : "PAGAMENTO CONFIRMADO"}</small><h1>Suas fichas estão prontas</h1><p>Apresente uma ficha por vez no bar.</p></div></div>
          <div className="ticket-grid">{order.tickets.map((ticket, index) => <TicketCard key={ticket.publicId} ticket={ticket} position={index + 1} total={order.tickets.length} />)}</div>
          <button className="ghost-button refresh-tickets" type="button" onClick={() => loadOrder()}>Atualizar fichas</button>
        </section>
      )}
      {order.status === "EXPIRED" && <section className="state-section"><span>⌛</span><h1>Este Pix expirou</h1><p>A reserva foi devolvida ao estoque. Se você pagou antes do vencimento, confira a confirmação do PagBank.</p><button className="secondary-button" type="button" onClick={() => loadOrder(true)}>Já paguei, verificar agora</button><a className="primary-button" href="/">Voltar ao cardápio</a></section>}
      {order.status === "PAYMENT_EXCEPTION" && <section className="state-section state-section--attention"><span>!</span><h1>Pagamento em análise manual</h1><p>Recebemos a confirmação depois da reserva. Procure a organização com o código {order.publicId}.</p></section>}
      {order.status === "CANCELLED" && <section className="state-section"><span>×</span><h1>Pedido cancelado</h1><a className="primary-button" href="/">Voltar ao cardápio</a></section>}
    </main>
  );
}

function PixQr({ code }: { code: string }) {
  const [image, setImage] = useState("");
  useEffect(() => { QRCode.toDataURL(code, { width: 280, margin: 2 }).then(setImage); }, [code]);
  return image ? <img src={image} alt="QR Code Pix" /> : <Loading label="Gerando Pix" />;
}
