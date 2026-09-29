import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import QRCode from "qrcode";
import { Logo } from "../components/Logo";
import { Loading } from "../components/Loading";
import { OrderSearchPanel, TeamPanel, ResultsAnalysis } from "../components/ManagementPanels";
import { StockManager } from "../components/StockManager";
import { StockAlerts } from "../components/StockAlerts";
import { ApiClientError, apiGet, apiPost, formatDate, money } from "../lib/api";
import type { StaffSession } from "../lib/types";

export interface DashboardData {
  summary: { revenue_cents: number; paid_orders: number; pending_orders: number; payment_exceptions: number };
  tickets: { total: number; used: number; available: number };
  products: Array<{
    id: string; slug: string; name: string; emoji: string; active: number; unit_price_cents: number; initial_quantity: number;
    adjustment_quantity: number; reserved_quantity: number; sold_quantity: number; courtesy_quantity: number;
    redeemed_quantity: number; available_quantity: number; physical_expected: number;
    stock_unit: string; portion_ml: number; low_stock_threshold: number; initial_volume_ml: number; adjustment_volume_ml: number;
  }>;
  campaigns: Array<{
    id: string; name: string; code_hint: string; status: string; total_limit: number; used_quantity: number;
    quantity_per_use: number; starts_at: string; expires_at: string;
  }>;
}

interface OperationalReportData {
  generatedAt: string;
  summary: {
    revenueCents: number; paidOrders: number; paidUnits: number; courtesyUnits: number;
    totalTickets: number; availableTickets: number; usedTickets: number; cancelledTickets: number;
  };
  salesByProduct: Array<{ productId: string; productName: string; paidUnits: number; courtesyUnits: number; revenueCents: number }>;
  detailedSales: Array<{
    orderPublicId: string; createdAt: string; customerName: string; customerCpf: string;
    productName: string; quantity: number; unitPriceCents: number; totalCents: number;
    paymentMethod: string; orderStatus: string;
  }>;
  ticketStatuses: Array<{ ticketCode: string; orderPublicId: string; productName: string; status: string; purchasedAt: string; usedAt: string }>;
  stockSummary: Array<{
    productId: string; productName: string; startingStock: number; adjustments: number;
    paidUnits: number; courtesyUnits: number; withdrawnUnits: number; reservedUnits: number;
    endingPhysicalStock: number; availableForSale: number;
  }>;
}

type ReportSection = "analysis" | "summary" | "sales" | "tickets" | "stock";

const reportSections: Array<{ id: ReportSection; label: string }> = [
  {id:"analysis",label:"Análise dos resultados"},
  { id: "summary", label: "Resumo de vendas" },
  { id: "sales", label: "Vendas detalhadas" },
  { id: "tickets", label: "Status das fichas" },
  { id: "stock", label: "Resumo de estoque" }
];

function BootstrapPanel({ onReady }: { onReady: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      await apiPost("/api/staff/bootstrap", { displayName, username, password, deviceLabel: "Administrador principal" });
      onReady();
    } catch (requestError) {
      setError(requestError instanceof ApiClientError ? requestError.message : "Não foi possível entrar.");
    } finally { setLoading(false); }
  }
  return (
    <main className="center-page staff-background"><section className="activation-card"><Logo /><span className="eyebrow">CONFIGURAÇÃO INICIAL</span><h1>Criar conta administrativa</h1><p>Defina o usuário e a senha que serão usados para entrar no painel.</p><form onSubmit={submit} className="form-grid"><label className="field field--wide"><span>Nome do administrador</span><input required value={displayName} onChange={event => setDisplayName(event.target.value)} /></label><label className="field field--wide"><span>Usuário</span><input required minLength={3} maxLength={40} pattern="[a-zA-Z0-9._-]+" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="admin" /></label><label className="field field--wide"><span>Senha</span><input required minLength={10} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Mínimo de 10 caracteres" /></label>{error && <div className="error-box field--wide">{error}</div>}<button className="primary-button primary-button--large field--wide" disabled={loading}>{loading ? "Criando…" : "Criar conta"}</button></form></section></main>
  );
}

function LoginPanel({ onReady }: { onReady: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      await apiPost("/api/staff/login", { username, password, deviceLabel: navigator.userAgent.includes("Mobile") ? "CPF administrativo" : "Computador administrativo" });
      onReady();
    } catch (requestError) {
      setError(requestError instanceof ApiClientError ? requestError.message : "Não foi possível entrar.");
    } finally { setLoading(false); }
  }
  return (
    <main className="center-page staff-background"><section className="activation-card"><Logo /><span className="eyebrow">ÁREA ADMINISTRATIVA</span><h1>Entrar</h1><p>Use sua conta para acessar estoque, cortesias, equipe e relatórios.</p><form onSubmit={submit} className="form-grid"><label className="field field--wide"><span>Usuário</span><input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label><label className="field field--wide"><span>Senha</span><input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>{error && <div className="error-box field--wide">{error}</div>}<button className="primary-button primary-button--large field--wide" disabled={loading}>{loading ? "Entrando…" : "Entrar"}</button></form></section></main>
  );
}

function ScannerPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lockRef = useRef(false);
  const resultTimerRef = useRef<number | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; title: string; message: string } | null>(null);

  function showResult(nextResult: { type: "success" | "error"; title: string; message: string }) {
    setResult(nextResult);
    if (resultTimerRef.current !== null) window.clearTimeout(resultTimerRef.current);
    resultTimerRef.current = window.setTimeout(() => setResult(null), 2600);
    if (navigator.vibrate) navigator.vibrate(nextResult.type === "success" ? [100, 50, 100] : 300);
  }

  const consume = useCallback(async (rawValue: string) => {
    if (lockRef.current) return;
    const token = rawValue.trim().replace(/^eventticket:/, "");
    if (!token) return;
    lockRef.current = true;
    try {
      const response = await apiPost<{ productName: string; redeemedAt: string }>("/api/tickets/redeem", { token });
      showResult({ type: "success", title: response.productName, message: `Ficha validada às ${new Date(response.redeemedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` });
    } catch (requestError) {
      showResult({ type: "error", title: "Ficha recusada", message: requestError instanceof ApiClientError ? requestError.message : "Não foi possível validar." });
    } finally {
      window.setTimeout(() => { lockRef.current = false; }, 2600);
    }
  }, []);

  async function startCamera() {
    if (!videoRef.current) return;
    setResult(null);
    try {
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, scanResult => {
        if (scanResult) void consume(scanResult.getText());
      });
      setCameraActive(true);
    } catch {
      showResult({ type: "error", title: "Câmera indisponível", message: "Autorize a câmera ou digite o código manualmente." });
    }
  }
  function stopCamera() { controlsRef.current?.stop(); controlsRef.current = null; setCameraActive(false); }
  useEffect(() => () => {
    controlsRef.current?.stop();
    if (resultTimerRef.current !== null) window.clearTimeout(resultTimerRef.current);
  }, []);

  return (
    <section className="scanner-panel">
      <div className="scanner-heading"><span className="eyebrow">VALIDAÇÃO NO BAR</span><h1>Aponte para a ficha</h1><p>A leitura só fica verde depois que o servidor confirma o consumo.</p></div>
      <div className={`scanner-view ${cameraActive ? "scanner-view--active" : ""}`}><video ref={videoRef} muted playsInline /><div className="scanner-frame"><i /><i /><i /><i /></div>{!cameraActive && <button className="primary-button" onClick={startCamera}>Abrir câmera</button>}</div>
      {cameraActive && <button className="ghost-button" onClick={stopCamera}>Parar câmera</button>}
      {result && <button type="button" className={`scan-feedback scan-feedback--${result.type}`} onClick={() => setResult(null)} aria-label={`${result.title}. ${result.message}. Toque para fechar.`}>
        <span className="scan-feedback__icon" aria-hidden="true"><svg viewBox="0 0 140 140"><circle className="scan-feedback__circle" cx="70" cy="70" r="64" />{result.type === "success" ? <path className="scan-feedback__mark" d="M42 72 L62 92 L100 50" /> : <path className="scan-feedback__mark" d="M50 50 L90 90 M90 50 L50 90" />}</svg></span>
        <strong>{result.title}</strong><span className="scan-feedback__message">{result.message}</span><i className="scan-feedback__timer" />
      </button>}
      <form className="manual-scan" onSubmit={event => { event.preventDefault(); void consume(manualCode); }}><label className="field"><span>Código manual</span><input value={manualCode} onChange={event => setManualCode(event.target.value)} placeholder="Cole o token da ficha" /></label><button className="secondary-button">Validar</button></form>
    </section>
  );
}

function ReportsPanel() {
  const [report, setReport] = useState<OperationalReportData | null>(null);
  const [section, setSection] = useState<ReportSection>("analysis");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await apiGet<OperationalReportData>("/api/admin/reports"));
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar o relatório.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading && !report) return <Loading label="Carregando relatório de vendas" />;
  if (!report) return <section><div className="error-box">{error || "Relatório indisponível."}</div><button className="secondary-button" onClick={load}>Tentar novamente</button></section>;

  const currentSection = reportSections.find(item => item.id === section)!;
  return (
    <section className="reports-panel">
      {section !== 'analysis' && <div className="dashboard-heading">
        <div><span className="eyebrow">RELATÓRIO DO EVENTO</span><h1>{currentSection.label}</h1><p>Atualizado em {formatDate(report.generatedAt)}</p></div>
        <div className="report-heading-actions"><button className="ghost-button" onClick={load}>Atualizar</button><a className="primary-button" href="/api/admin/reports/csv">Baixar relatório geral CSV</a></div>
      </div>}
      <nav className="report-tabs" aria-label="Seções do relatório">
        {reportSections.map(item => <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>{item.label}</button>)}
      </nav>
      {error && <div className="error-box">{error}</div>}
      {section === "analysis" && <ResultsAnalysis/>}
      {section === "summary" && <>
        <div className="metric-grid report-metrics">
          <Metric label="Vendas pagas" value={money(report.summary.revenueCents)} accent />
          <Metric label="Pedidos pagos" value={report.summary.paidOrders} />
          <Metric label="Bebidas vendidas" value={report.summary.paidUnits} />
          <Metric label="Cortesias concedidas" value={report.summary.courtesyUnits} />
        </div>
        <ReportBarChart title="Unidades vendidas por bebida" values={report.salesByProduct.map(item => ({ label: item.productName, value: item.paidUnits, display: `${item.paidUnits}` }))} />
        <ReportTable headers={["Produto", "Unidades vendidas", "Cortesias", "Faturamento"]} rows={report.salesByProduct.map(item => [item.productName, item.paidUnits, item.courtesyUnits, money(item.revenueCents)])} />
      </>}
      {section === "sales" && <ReportTable headers={["Pedido", "Data/hora", "Cliente", "CPF", "Produto", "Qtd.", "Unitário", "Total", "Pagamento", "Status"]} rows={report.detailedSales.map(item => [item.orderPublicId, formatDate(item.createdAt), item.customerName || "—", item.customerCpf || "—", item.productName, item.quantity, money(item.unitPriceCents), money(item.totalCents), item.paymentMethod, item.orderStatus])} />}
      {section === "tickets" && <>
        <div className="metric-grid report-metrics">
          <Metric label="Total de fichas" value={report.summary.totalTickets} />
          <Metric label="Disponíveis" value={report.summary.availableTickets} />
          <Metric label="Retiradas" value={report.summary.usedTickets} />
          <Metric label="Canceladas" value={report.summary.cancelledTickets} />
        </div>
        <ReportBarChart title="Fichas por status" values={[
          { label: "Disponíveis", value: report.summary.availableTickets, display: `${report.summary.availableTickets}` },
          { label: "Retiradas", value: report.summary.usedTickets, display: `${report.summary.usedTickets}` },
          { label: "Canceladas", value: report.summary.cancelledTickets, display: `${report.summary.cancelledTickets}` }
        ]} />
        <ReportTable headers={["Código", "Pedido", "Produto", "Status", "Compra", "Retirada"]} rows={report.ticketStatuses.map(item => [item.ticketCode, item.orderPublicId, item.productName, item.status, formatDate(item.purchasedAt), item.usedAt ? formatDate(item.usedAt) : "—"])} />
      </>}
      {section === "stock" && <>
        <p className="report-note">O estoque físico final é uma estimativa: estoque inicial + ajustes − fichas já retiradas.</p>
        <StockChart products={report.stockSummary} />
        <ReportTable headers={["Produto", "Estoque inicial", "Ajustes", "Vendidas", "Cortesias", "Retiradas", "Reservadas", "Físico final esperado", "Disponível p/ venda"]} rows={report.stockSummary.map(item => [item.productName, item.startingStock, item.adjustments, item.paidUnits, item.courtesyUnits, item.withdrawnUnits, item.reservedUnits, item.endingPhysicalStock, item.availableForSale])} />
      </>}
    </section>
  );
}

function ReportBarChart({ title, values }: { title: string; values: Array<{ label: string; value: number; display: string }> }) {
  const max = Math.max(1, ...values.map(item => item.value));
  return <div className="report-chart"><h2>{title}</h2>{values.map(item => <div className="report-chart__row" key={item.label}><div><span>{item.label}</span><strong>{item.display}</strong></div><div className="report-chart__track"><i style={{ width: `${item.value === 0 ? 0 : Math.max(2, item.value / max * 100)}%` }} /></div></div>)}</div>;
}

function StockChart({ products }: { products: OperationalReportData["stockSummary"] }) {
  const max = Math.max(1, ...products.flatMap(item => [item.startingStock, item.endingPhysicalStock]));
  return <div className="report-chart"><h2>Estoque inicial e final esperado</h2>{products.map(item => <div className="stock-chart__product" key={item.productId}><strong>{item.productName}</strong><div><span>Início <b>{item.startingStock}</b></span><i className="stock-chart__bar stock-chart__bar--start" style={{ width: `${item.startingStock === 0 ? 0 : Math.max(2, item.startingStock / max * 100)}%` }} /></div><div><span>Final <b>{item.endingPhysicalStock}</b></span><i className="stock-chart__bar stock-chart__bar--end" style={{ width: `${item.endingPhysicalStock === 0 ? 0 : Math.max(2, item.endingPhysicalStock / max * 100)}%` }} /></div></div>)}</div>;
}

function ReportTable({ headers, rows }: { headers: string[]; rows: Array<Array<string | number>> }) {
  return <div className="report-table-wrap"><table className="report-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={`${index}-${String(row[0])}`}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>) : <tr><td className="report-empty" colSpan={headers.length}>Ainda não há registros.</td></tr>}</tbody></table></div>;
}

async function createBrandedMenuQr(menuUrl: string, width: number) {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, menuUrl, {
    width,
    margin: 3,
    // Extra correction keeps the QR readable with the brand mark over its center.
    errorCorrectionLevel: "H",
    color: { dark: "#171717ff", light: "#ffffffff" }
  });
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Não foi possível preparar o QR Code.");

  const logo = new Image();
  logo.src = "/brand/lunaticos-qr-mark.png";
  await logo.decode();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const backingSize = canvas.width * 0.22;
  const logoWidth = backingSize * 0.78;
  const logoHeight = logoWidth * (178 / 210);
  context.fillStyle = "#ffffff";
  context.fillRect(centerX - backingSize / 2, centerY - backingSize / 2, backingSize, backingSize);
  // The supplied QR mark has transparent margins, so crop to the visible symbol here.
  context.drawImage(logo, 213, 415, 210, 178, centerX - logoWidth / 2, centerY - logoHeight / 2, logoWidth, logoHeight);
  return canvas.toDataURL("image/png");
}

function EventHomePanel({ operatorName, onEnter, canManageTeam }: { operatorName: string; onEnter: () => void; canManageTeam: boolean }) {
  const [qrImage, setQrImage] = useState("");
  const [copied, setCopied] = useState(false);
  const [qrError, setQrError] = useState("");
  const [scannerLink, setScannerLink] = useState<{ activationUrl: string; expiresAt: string } | null>(null);
  const [scannerLinkError, setScannerLinkError] = useState("");
  const menuUrl = `${window.location.origin}/`;

  useEffect(() => {
    let active = true;
    void createBrandedMenuQr(menuUrl, 420)
      .then(image => { if (active) setQrImage(image); })
      .catch(() => { if (active) setQrError("Não foi possível gerar o QR agora."); });
    return () => { active = false; };
  }, [menuUrl]);

  async function copyMenuUrl() {
    try {
      await navigator.clipboard.writeText(menuUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setQrError("Não foi possível copiar o link neste navegador.");
    }
  }

  async function createScannerLink() {
    setScannerLinkError('');
    try {
      const result = await apiPost<{ activationUrl: string; expiresAt: string }>("/api/admin/scanner-links", {});
      setScannerLink(result);
      setScannerLinkError("");
    } catch (requestError) {
      setScannerLinkError(requestError instanceof Error ? requestError.message : "Não foi possível gerar o link de leitura.");
    }
  }

  async function copyScannerLink() {
    if (!scannerLink) return;
    try {
      await navigator.clipboard.writeText(scannerLink.activationUrl);
      setScannerLinkError("Link copiado. Envie para a pessoa responsável pela leitura.");
    } catch {
      setScannerLinkError("Não foi possível copiar o link neste navegador.");
    }
  }

  return (
    <main className="event-home">
      <section className="event-home__intro">
        <h1>Olá, {operatorName.trim().split(/\s+/)[0]}</h1>
        <p>Gerencie seu evento e compartilhe o cardápio digital abaixo.</p>
      </section>

      <section className="event-home__qr-card" aria-labelledby="menu-qr-title">
        <div className="event-home__qr-heading">
          <span className="event-home__qr-icon" aria-hidden="true">QR</span>
          <div><h2 id="menu-qr-title">Meu QR fixo</h2><p>Aponta sempre para o cardápio da Lunáticos.</p></div>
        </div>
        <div className="event-home__qr-content">
          <div className="event-home__qr-preview">
            {qrImage ? <img src={qrImage} alt="QR Code do cardápio Lunáticos com a logo no centro" /> : <Loading label="Gerando QR" />}
          </div>
          <div className="event-home__qr-actions">
            <div className="event-home__url"><span>{menuUrl}</span><button className="ghost-button" onClick={copyMenuUrl} aria-label="Copiar link do cardápio">{copied ? "Copiado" : "Copiar"}</button></div>
            <a className={`primary-button event-home__download ${!qrImage ? "event-home__download--disabled" : ""}`} href={qrImage || undefined} download="lunaticos-qr-cardapio.png" aria-disabled={!qrImage}>
              Baixar meu QR fixo
            </a>
            {qrError && <p className="event-home__qr-error" role="status">{qrError}</p>}
          </div>
        </div>
        <div className="event-home__current-event"><span>EVENTO NO QR AGORA</span><strong>Lunáticos UFPR</strong><b>Cardápio oficial</b></div>
        {canManageTeam && <section className="event-home__scanner-link" aria-labelledby="scanner-link-title">
          <div><h3 id="scanner-link-title">Link para leitura de QR codes</h3><p>Gere o link e envie para quem vai validar as fichas no evento.</p></div>
          <button className="secondary-button" onClick={()=>void createScannerLink()}>Gerar link de leitura</button>
          <p>Compartilhe o link privado com os leitores. Cada um informa o nome ao entrar.</p>
          {scannerLink && <div className="event-home__scanner-result"><div className="event-home__url"><span>{scannerLink.activationUrl}</span><button type="button" className="ghost-button" onClick={copyScannerLink}>Copiar link</button></div><small>Válido até {formatDate(scannerLink.expiresAt)} para até 50 entradas identificadas.</small></div>}
          {scannerLinkError && <p className="event-home__qr-error" role="status">{scannerLinkError}</p>}
        </section>}
      </section>

      <article className="event-home__event-card">
        <div className="event-home__event-mark" aria-hidden="true"><img src="/brand/lunaticos-mark.png" alt="" /></div>
        <div className="event-home__event-copy"><span>EVENTO ATUAL</span><h2>Lunáticos UFPR</h2><p>Vendas, estoque, cupons e operação</p></div>
        <button className="primary-button" onClick={onEnter}>Entrar no evento</button>
      </article>
    </main>
  );
}

function DashboardPanel({ role, onBack }: { role: "ADMIN" | "MARKETING"; onBack: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "inventory" | "campaigns" | "devices" | "health" | "reports" | "orders">(role === 'ADMIN' ? ({stock:'inventory',orders:'orders',team:'devices',results:'reports',payments:'health'} as const)[new URLSearchParams(location.search).get('view') as 'stock'|'orders'|'team'|'results'|'payments'] ?? 'overview' : 'overview');


  const load = useCallback(async () => {
    try {
      setData(await apiGet<DashboardData>("/api/admin/dashboard"));
      if (role === "ADMIN") setHealth(await apiGet("/api/admin/health"));
      setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Falha ao atualizar o painel."); }
  }, [role]);
  useEffect(() => { void load(); const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10_000); return () => window.clearInterval(id); }, [load]);

  async function toggleCampaign(campaignId: string, active: boolean) {
    try {
      await apiPost(`/api/admin/campaigns/${campaignId}/status`, { active });
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update this coupon.");
    }
  }
  async function createCourtesy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    const productId = String(form.get("productId") ?? "");
    try {
      const result = await apiPost<{ code: string }>("/api/admin/campaigns", {
        name: form.get("name"), code: form.get("code"), productId,
        totalLimit: Number(form.get("totalLimit")), quantityPerUse: Number(form.get("quantityPerUse")),
        startsAt: new Date(String(form.get("startsAt"))).toISOString(), expiresAt: new Date(String(form.get("expiresAt"))).toISOString()
      });
      alert(`Campanha criada. Código: ${result.code}`); formElement.reset(); await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não foi possível criar a campanha."); }
  }

  if (!data) return <Loading label="Montando o painel" />;
  return (
    <div className={`admin-layout ${tab === 'inventory' ? 'admin-layout--stock' : ''}`}>
      <div className="event-workspace-heading">
        <button className="secondary-button" onClick={onBack}>← Voltar</button>
        <div><span className="eyebrow">EVENTO ATUAL</span><h1>Lunáticos UFPR</h1></div>
        <span className="event-workspace-heading__status"><i /> Ativo</span>
      </div>
      {tab !== "overview" && <nav className="admin-tabs"><button className="admin-back-button" onClick={() => setTab("overview")}>← Voltar à visão geral</button></nav>}
      {error && <div className="error-box">{error}</div>}
      {tab === "reports" && <ReportsPanel />}
      {tab === "orders" && role === "ADMIN" && <OrderSearchPanel/>}
      {tab === "overview" && <section><div className="dashboard-heading"><div><span className="eyebrow">OPERAÇÃO EM TEMPO REAL</span><h1>Painel do evento</h1></div><button className="ghost-button" onClick={load}>Atualizar</button></div><div className="event-quick-actions" aria-label="Acessos rápidos do evento">
        {role === "ADMIN" && <button onClick={() => setTab("inventory")}><span>Estoque e bebidas</span><b>Gerenciar disponibilidade <i>→</i></b></button>}
        <button onClick={() => setTab("campaigns")}><span>Cupons de cortesia</span><b>Ver e criar cupons <i>→</i></b></button>
        {role === "ADMIN" && <button onClick={()=>setTab("orders")}><span>Consultar pedidos</span><b>Buscar cliente e fichas <i>→</i></b></button>}
        {role === "ADMIN" && <button onClick={() => setTab("devices")}><span>Acesso da equipe</span><b>Consultar leitores e administradores <i>→</i></b></button>}
        {role === "ADMIN" && <button onClick={() => setTab("reports")}><span>Relatório do evento</span><b>Gráficos, Pareto e indicadores <i>→</i></b></button>}
        {role === "ADMIN" && <button onClick={() => setTab("health")}><span>Saúde do sistema</span><b>Pagamentos, fiscal e jurídico <i>→</i></b></button>}
      </div><div className="metric-grid"><Metric label="Faturamento" value={money(data.summary.revenue_cents)} accent /><Metric label="Pedidos pagos" value={data.summary.paid_orders} /><Metric label="Fichas retiradas" value={data.tickets.used} /><Metric label="Ainda disponíveis" value={data.tickets.available} /><Metric label="Aguardando Pix" value={data.summary.pending_orders} /><Metric label="Exceções" value={data.summary.payment_exceptions} warning={data.summary.payment_exceptions > 0} /></div>{role === "ADMIN" && <div className="report-links"><a className="primary-button" href="/api/admin/reports/csv">Baixar relatório geral CSV</a></div>}<ProductTable products={data.products} /></section>}
      {tab === "inventory" && role === "ADMIN" && <StockManager products={data.products} onChanged={load} />}
      {tab === "campaigns" && <section><div className="dashboard-heading"><div><span className="eyebrow">MARKETING</span><h1>Cupons de cortesia</h1></div></div><form className="admin-form" onSubmit={createCourtesy}><label className="field"><span>Nome da campanha</span><input name="name" required /></label><label className="field"><span>Código compartilhável</span><input name="code" required pattern="[A-Za-z0-9-]{4,40}" placeholder="MKT-2026" /></label><label className="field"><span>Limite total</span><input name="totalLimit" type="number" min="1" required /></label><label className="field"><span>Itens por uso</span><input name="quantityPerUse" type="number" min="1" defaultValue="1" required /></label><label className="field"><span>Início</span><input name="startsAt" type="datetime-local" required /></label><label className="field"><span>Fim</span><input name="expiresAt" type="datetime-local" required /></label><label className="field"><span>Produto deste cupom</span><select name="productId" required defaultValue=""><option value="" disabled>Selecione o produto</option>{data.products.filter(product => product.active).map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><button className="primary-button">Criar cupom</button></form><div className="campaign-list">{data.campaigns.map(campaign => <CampaignRow key={campaign.id} campaign={campaign} onToggle={toggleCampaign} />)}</div></section>}
      {tab === "devices" && role === "ADMIN" && <TeamPanel/>}
      {tab === "health" && role === "ADMIN" && <OrderSearchPanel payments/>}
      {tab === "health" && role === "ADMIN" && health && <details><summary>Saúde técnica e cotas</summary><section><div className="dashboard-heading"><div><span className="eyebrow">PLANO GRATUITO</span><h1>Saúde e cotas</h1></div></div><div className="health-card"><div><span className={`health-dot health-dot--${String(health.status).toLowerCase()}`} /> <strong>{health.status === "OK" ? "Operação normal" : "Requer atenção"}</strong></div><dl><div><dt>Modo de pagamento</dt><dd>{health.paymentMode}</dd></div><div><dt>Pedidos registrados</dt><dd>{health.counts.orders}</dd></div><div><dt>Webhooks em 24h</dt><dd>{health.counts.webhooks_24h}</dd></div><div><dt>Estimativa de chamadas</dt><dd>{health.freeTier.projectedDynamicRequests.toLocaleString("pt-BR")} / {health.freeTier.operationalBudget.toLocaleString("pt-BR")}</dd></div></dl><div className="quota-bar"><span style={{ width: `${Math.min(100, health.freeTier.projectedDynamicRequests / health.freeTier.operationalBudget * 100)}%` }} /></div><p>{health.freeTier.note}</p></div></section></details>}
    </div>
  );
}

function Metric({ label, value, accent, warning }: { label: string; value: string | number; accent?: boolean; warning?: boolean }) { return <article className={`metric-card ${accent ? "metric-card--accent" : ""} ${warning ? "metric-card--warning" : ""}`}><span>{label}</span><strong>{value}</strong></article>; }
function ProductTable({ products }: { products: DashboardData["products"] }) { return <div className="data-table"><div className="data-table__head"><span>Produto</span><span>Vendidos</span><span>Disponíveis</span></div>{products.map(product => <div className="data-table__row" key={product.id}><span>{product.name}</span><span>{product.sold_quantity}</span><span>{product.available_quantity}</span></div>)}</div>; }
function CampaignRow({ campaign, onToggle }: { campaign: DashboardData["campaigns"][number]; onToggle: (campaignId: string, active: boolean) => Promise<void> }) {
  const now = Date.now();
  const expired = Date.parse(campaign.expires_at) <= now;
  const notStarted = Date.parse(campaign.starts_at) > now;
  const exhausted = campaign.used_quantity >= campaign.total_limit;
  const canSuspend = campaign.status === "ACTIVE";
  const statusLabel = exhausted ? "Esgotado" : expired ? "Expirado" : notStarted ? "Agendado" : canSuspend ? "Ativo" : campaign.status === "DISABLED" ? "Suspenso" : campaign.status;
  const canReactivate = campaign.status === "DISABLED" && !expired && !exhausted;
  return <article><div><small>{statusLabel}</small><h3>{campaign.name}</h3><p>Código {campaign.code_hint} | {campaign.quantity_per_use} por uso</p></div><strong>{campaign.used_quantity}/{campaign.total_limit}</strong>{canSuspend && <button className="secondary-button" onClick={() => void onToggle(campaign.id, false)}>Suspender</button>}{canReactivate && <button className="secondary-button" onClick={() => void onToggle(campaign.id, true)}>Reativar</button>}</article>;
}

export function StaffPage() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [eventWorkspaceOpen, setEventWorkspaceOpen] = useState(['overview','stock','orders','team','results','payments'].includes(new URLSearchParams(location.search).get('view')??''));
  const loadSession = useCallback(() => apiGet<StaffSession>("/api/staff/me").then(setSession), []);
  useEffect(() => { void loadSession(); }, [loadSession]);
  if (!session) return <main className="center-page staff-background"><Loading label="Verificando aparelho" /></main>;
  if (!session.authenticated || !session.operator) return session.setupRequired ? <BootstrapPanel onReady={loadSession} /> : <LoginPanel onReady={loadSession} />;
  const operator = session.operator;
  const roleLabel = operator.role === "EVENTOS" ? "Eventos" : operator.role === "ADMIN" ? "Administrador" : operator.role === "MARKETING" ? "Marketing" : "Bartender";
  return <main className="staff-page"><header className="staff-topbar"><Logo compact /><div><span>{operator.displayName}</span><small>{roleLabel} • {operator.deviceLabel}</small></div><button className="ghost-button" onClick={async () => { await apiPost("/api/staff/logout"); setEventWorkspaceOpen(false); await loadSession(); }}>Sair</button></header>{operator.role === "ADMIN" && <StockAlerts />}{operator.role === "BARTENDER" || operator.role === "EVENTOS" ? <ScannerPanel /> : eventWorkspaceOpen ? <DashboardPanel role={operator.role} onBack={() => setEventWorkspaceOpen(false)} /> : <EventHomePanel operatorName={operator.displayName} canManageTeam={operator.role === "ADMIN"} onEnter={() => setEventWorkspaceOpen(true)} />}</main>;
}

