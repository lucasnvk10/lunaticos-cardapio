import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { Loading } from "../components/Loading";
import { ApiClientError, apiGet, apiPost, createBrowserToken, money } from "../lib/api";
import type { Catalog, CatalogProduct, OrderView } from "../lib/types";

type Cart = Record<string, number>;

function formatBrazilianPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : "";
  const areaCode = digits.slice(0, 2);
  const localNumber = digits.slice(2);
  const splitAt = localNumber.length > 8 ? 5 : 4;
  return `(${areaCode}) ${localNumber.slice(0, splitAt)}${localNumber.length > splitAt ? `-${localNumber.slice(splitAt)}` : ""}`;
}

function formatBrazilianCpf(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function ProductCard({ product, quantity, onChange }: {
  product: CatalogProduct;
  quantity: number;
  onChange: (next: number) => void;
}) {
  const soldOut = product.available_quantity <= 0;
  const productImageBySlug: Record<string, string> = {
    chopp: "/products/cerveja.webp",
    chevette: "/products/chevette.webp",
    jurupinga: "/products/jurupinga.webp",
    "vodka-energetico": "/products/vodkaenergetico.webp",
    gummy: "/products/gummy.webp",
    agua: "/products/agua.webp"
  };
  const productImage = productImageBySlug[product.slug] ?? "/products/cerveja.webp";
  return (
    <article className={`product-card ${soldOut ? "product-card--disabled" : ""}`}>
      <div className="product-card__image-wrap">
        <img className="product-card__image" src={productImage} alt={product.name} loading="lazy" />
      </div>
      <div className="product-card__body">
        <h3>{product.name}</h3>
        <p>{product.description}</p>
        <strong className="product-card__price">{money(product.unit_price_cents)}</strong>
        <div className="product-card__footer">
          <span className={soldOut || product.available_quantity < 20 ? "stock stock--low" : "stock"}>
            {soldOut ? "Esgotado" : product.available_quantity < 20 ? `Últimas ${product.available_quantity}` : "Disponível"}
          </span>
          <div className="stepper" aria-label={`Quantidade de ${product.name}`}>
            <button type="button" onClick={() => onChange(Math.max(0, quantity - 1))} disabled={quantity === 0}>−</button>
            <span>{quantity}</span>
            <button type="button" onClick={() => onChange(Math.min(20, quantity + 1))} disabled={soldOut || quantity >= product.available_quantity}>+</button>
          </div>
        </div>
      </div>
    </article>
  );
}

function CheckoutSheet({ catalog, cart, onClose }: { catalog: Catalog; cart: Cart; onClose: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"PIX" | "COURTESY">("PIX");
  const [form, setForm] = useState({ name: "", cpf: "", phone: "", courtesyCode: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selected = catalog.products.filter(product => (cart[product.id] ?? 0) > 0);
  const total = selected.reduce((sum, product) => sum + product.unit_price_cents * cart[product.id], 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const accessToken = createBrowserToken();
    const idempotencyKey = crypto.randomUUID().replaceAll("-", "");
    try {
      const order = mode === "PIX"
        ? await apiPost<OrderView>("/api/orders", {
            idempotencyKey,
            accessToken,
            customer: { name: form.name, taxId: form.cpf, phone: form.phone },
            items: selected.map(product => ({ productId: product.id, quantity: cart[product.id] }))
          })
        : await apiPost<OrderView>("/api/courtesies/redeem", {
            idempotencyKey,
            accessToken,
            code: form.courtesyCode
          });
      const privateLink = `/pedido/${order.publicId}#token=${accessToken}`;
      localStorage.setItem("last-event-order", privateLink);
      navigate(privateLink);
    } catch (requestError) {
      setError(requestError instanceof ApiClientError ? requestError.message : "Não foi possível criar o pedido.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="checkout-sheet" role="dialog" aria-modal="true" aria-label="Finalizar pedido">
        <header className="checkout-sheet__header">
          <div><span className="eyebrow">SEU PEDIDO</span><h2>Quase lá</h2></div>
          <button className="secondary-button" type="button" onClick={onClose}>← Voltar ao cardápio</button>
        </header>
        <div className="mode-tabs">
          <button type="button" className={mode === "PIX" ? "active" : ""} onClick={() => setMode("PIX")}>Pagar com Pix</button>
          <button type="button" className={mode === "COURTESY" ? "active" : ""} onClick={() => setMode("COURTESY")}>Usar cortesia</button>
        </div>
        <form onSubmit={submit}>
          {mode === "PIX" ? (
            <>
              <div className="order-lines">
                {selected.map(product => (
                  <div key={product.id}><span>{cart[product.id]}× {product.name}</span><strong>{money(product.unit_price_cents * cart[product.id])}</strong></div>
                ))}
                <div className="order-lines__total"><span>Total</span><strong>{money(total)}</strong></div>
              </div>
              <div className="form-grid">
                <label className="field field--wide"><span>Nome completo</span><input required maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Como aparece no documento" /></label>
                <label className="field field--wide"><span>Telefone com DDD (opcional)</span><input type="tel" autoComplete="tel-national" maxLength={15} value={form.phone} onChange={e=>setForm({...form,phone:formatBrazilianPhone(e.target.value)})} placeholder="(41) 99999-9999"/><small>Ajuda a localizar seu pedido no atendimento.</small></label>
                <label className="field field--wide"><span>CPF</span><input required inputMode="numeric" autoComplete="off" maxLength={14} value={form.cpf} onChange={e => setForm({ ...form, cpf: formatBrazilianCpf(e.target.value) })} placeholder="000.000.000-00" /></label>
              </div>
            </>
          ) : (
            <div className="form-grid">
              <label className="field field--wide"><span>Código do cupom</span><input required value={form.courtesyCode} onChange={e => setForm({ ...form, courtesyCode: e.target.value.toUpperCase() })} placeholder="DIGITE SEU CUPOM" /></label>
              <p className="form-help field--wide">O cupom identifica o produto e a quantidade. O estoque é confirmado ao finalizar.</p>
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button primary-button--large" disabled={submitting} type="submit">
            {submitting ? "Confirmando disponibilidade…" : mode === "PIX" ? `Gerar Pix de ${money(total)}` : "Resgatar cortesia"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function MenuPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [stockNotice, setStockNotice] = useState('');
  const [stockOffline, setStockOffline] = useState(false);
  const cartRef = useRef(cart);
  useEffect(() => { cartRef.current = cart; }, [cart]);
  const lastOrder = localStorage.getItem("last-event-order");

  useEffect(() => {
    let active = true; let inFlight = false; let opened = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const next = await apiGet<Catalog>('/api/catalog', { cache: 'no-store' });
        if (!active) return;
        const nextCart: Cart = {};
        for (const product of next.products) {
          const quantity = Math.min(cartRef.current[product.id] ?? 0, product.available_quantity);
          if (quantity > 0) nextCart[product.id] = quantity;
        }
        if (Object.entries(cartRef.current).some(([id, qty]) => qty > 0 && nextCart[id] !== qty)) {
          setStockNotice('O estoque mudou. Ajustamos o carrinho ao que ainda está disponível.');
          cartRef.current = nextCart; setCart(nextCart);
          if (!Object.keys(nextCart).length) setCheckoutOpen(false);
        }
        opened = true; setCatalog(next); setStockOffline(false); setError('');
      } catch (e) {
        if (!active) return;
        if (!opened) setError(e instanceof Error ? e.message : 'Não foi possível abrir o cardápio.');
        else setStockOffline(true);
      } finally { inFlight = false; if (active) setLoading(false); }
    };
    void refresh(); const timer = window.setInterval(refresh, 15000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(()=>{
    try {
      let visitorId=localStorage.getItem('event-visitor-id');
      if(!visitorId) {visitorId=createBrowserToken();localStorage.setItem('event-visitor-id',visitorId);}
      void apiPost('/api/visits',{visitorId}).catch(()=>{});
    } catch { /* Counting is optional when browser storage is unavailable. */ }
  },[]);

  const cartUnits = useMemo(() => Object.values(cart).reduce((sum, quantity) => sum + quantity, 0), [cart]);
  const cartTotal = useMemo(() => catalog?.products.reduce((sum, product) => sum + (cart[product.id] ?? 0) * product.unit_price_cents, 0) ?? 0, [catalog, cart]);

  if (loading) return <main className="center-page"><Loading label="Abrindo o cardápio" /></main>;
  if (!catalog || error) return <main className="center-page"><div className="state-card"><span>☾</span><h1>Cardápio indisponível</h1><p>{error}</p><button className="primary-button" onClick={() => location.reload()}>Tentar novamente</button></div></main>;

  return (
    <main className="menu-page">
      <header className="topbar"><Logo compact /><nav className="topbar__links">{lastOrder ? <a className="ticket-link" href={lastOrder}>Meus tickets</a> : <span className="ticket-link ticket-link--disabled">Meus tickets</span>}<a className="team-link" href="/equipe">Admin</a></nav></header>
      <section className="hero">
        <span className="eyebrow">LUNÁTICOS UFPR</span>
        <h1>Cardápio oficial da Lunáticos</h1>
        <div className="hero__steps"><span><b>1</b> Escolha</span><i /><span><b>2</b> Pague</span><i /><span><b>3</b> Retire</span></div>
        {lastOrder && <a className="last-order" href={lastOrder}>Abrir meus tickets <span>→</span></a>}
      </section>
      <section className="catalog-section">
        <div className="section-heading"><div><span className="eyebrow">ESCOLHA SEUS ITENS</span><h2>Bebidas</h2></div><span className="live-pill"><i /> {stockOffline ? 'Sem atualização' : 'Estoque atualizado'}</span></div>
        {stockNotice && <p className="stock-blocked" role="status">{stockNotice}</p>}
        {stockOffline && <p className="error-box">Verifique a conexão. O estoque será confirmado ao finalizar.</p>}
        <div className="product-grid">
          {catalog.products.map(product => <ProductCard key={product.id} product={product} quantity={cart[product.id] ?? 0} onChange={quantity => setCart(current => ({ ...current, [product.id]: quantity }))} />)}
        </div>
      </section>
      <footer className="menu-footer"><Logo compact /><p>Compre, pague e apresente seu ticket no bar.</p></footer>
      {cartUnits > 0 && <div className="floating-cart"><div><span>{cartUnits} {cartUnits === 1 ? "item" : "itens"}</span><strong>{money(cartTotal)}</strong></div><button type="button" onClick={() => setCheckoutOpen(true)}>Continuar <span>→</span></button></div>}
      {checkoutOpen && <CheckoutSheet catalog={catalog} cart={cart} onClose={() => setCheckoutOpen(false)} />}
    </main>
  );
}
