import {useCallback,useEffect,useState} from 'react';
import {apiGet,apiPost,formatDate,money} from '../lib/api';

const statusLabels:Record<string,string>={PAID:'Pago',PENDING_PAYMENT:'Aguardando Pix',EXPIRED:'Expirado',PAYMENT_EXCEPTION:'Pagamento com exceção',CANCELLED:'Cancelado'};
interface Order {number:string;name:string|null;phone:string|null;status:string;kind:string;amount:number;createdAt:string;paidAt:string|null;provider:string|null;chargeId:string|null;items:Array<{name:string;quantity:number;used:number;available:number}>}
interface OrderResult {orders:Order[];total:number;page:number;received:{real:number;test:number}|null}
interface DocumentRecord {id:string;kind:string;title:string;url:string;orderNumber:string|null;createdAt:string}

function printReceipt(order:Order) {
  const popup=window.open('','_blank');
  if (!popup) return;
  const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  popup.document.write(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Comprovante do pedido</title><style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:20px}li{margin:12px 0}@media print{button{display:none}}</style><h1>Comprovante do pedido</h1><p>Não é documento fiscal.</p><p>Pedido: ${escape(order.number)}</p><p>Cliente: ${escape(order.name)}</p><p>Pago em: ${escape(formatDate(order.paidAt??order.createdAt))}</p><ul>${order.items.map(i=>`<li>${i.quantity} × ${escape(i.name)}</li>`).join('')}</ul><h2>${escape(money(order.amount))}</h2><p>Provedor: ${escape(order.provider??'Não informado')}${order.provider?.toUpperCase()!=='PAGBANK'?' · Ambiente de teste ou provedor não confirmado':''}</p><p>Referência: ${escape(order.chargeId??'Não disponível')}</p><button onclick="window.print()">Imprimir / salvar PDF</button></html>`);
  popup.document.close();
}

export function OrderSearchPanel({payments=false}:{payments?:boolean}) {
  const [query,setQuery]=useState('');
  const [search,setSearch]=useState('');
  const [page,setPage]=useState(1);
  const [data,setData]=useState<OrderResult|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{setBusy(true);try {setData(await apiGet(`/api/admin/order-search?q=${encodeURIComponent(search)}&page=${page}&payments=${payments?1:0}`));setError('');}catch(e){setError(e instanceof Error?e.message:'Falha na consulta.');}finally{setBusy(false);}},[search,page,payments]);
  useEffect(()=>{void load();},[load]);
  return <section className="management-panel"><div className="dashboard-heading"><div><span className="eyebrow">{payments?'FINANCEIRO':'ATENDIMENTO'}</span><h1>{payments?'Pagamentos e documentos':'Consultar pedidos'}</h1></div><button className="ghost-button" onClick={()=>void load()} disabled={busy}>Atualizar</button></div>
    {payments&&data?.received&&<div className="metric-grid"><article className="metric-card"><span>PagBank confirmado · bruto</span><strong>{money(data.received.real)}</strong></article><article className="metric-card"><span>Testes / outros provedores</span><strong>{money(data.received.test)}</strong></article></div>}
    <form className="order-search" onSubmit={e=>{e.preventDefault();setPage(1);setSearch(query.trim());}}><label className="field"><span>Nome, telefone ou número do pedido</span><input value={query} onChange={e=>setQuery(e.target.value)} maxLength={120} placeholder="Ex.: Maria ou telefone com DDD" /></label><button className="primary-button" disabled={busy}>Consultar</button></form>
    <p className="muted">{payments?'Valores brutos confirmados no sistema. Taxas, repasses e estornos precisam de conciliação com o provedor.':'Confira os itens do pedido e quantas fichas ainda podem ser retiradas. O telefone só encontra pedidos em que ele foi cadastrado.'}</p>
    {error&&<div className="error-box" role="alert">{error}</div>}
    {busy&&<p role="status">Consultando…</p>}
    {!busy&&data?.total===0&&<p>Nenhum pedido encontrado.</p>}
    <div className="management-cards">{data?.orders.map(order=><article className="management-card" key={order.number}><div className="management-card__head"><h3>{order.name|| (order.kind==='COURTESY'?'Cortesia':'Cliente sem nome')}</h3><span className={`order-badge ${order.status==='PAID'?'order-badge--paid':''}`}>{statusLabels[order.status]||order.status}</span></div><p className="order-reference">{order.number}</p><p>{formatDate(order.createdAt)}{order.phone&&` · ${order.phone}`}</p><strong>{order.kind==='COURTESY'?'Cortesia':money(order.amount)}</strong><ul>{order.items.map((item,index)=><li key={index}><b>{item.quantity} × {item.name}</b><span>{item.used} retiradas · {item.available} disponíveis</span></li>)}</ul>{payments&&<p>{order.provider||'Provedor não registrado'}{order.provider?.toUpperCase()!=='PAGBANK'&&' · Teste / não confirmado'}</p>}{payments&&order.status==='PAID'&&<button className="secondary-button" onClick={()=>printReceipt(order)}>Comprovante do pedido</button>}</article>)}</div>
    {data&&data.total>0&&<div className="pagination"><button className="secondary-button" disabled={busy||page===1} onClick={()=>setPage(p=>p-1)}>Anterior</button><span>{page} / {Math.ceil(data.total/25)} · {data.total} pedidos</span><button className="secondary-button" disabled={busy||page*25>=data.total} onClick={()=>setPage(p=>p+1)}>Próxima</button></div>}
    {payments&&<DocumentsPanel/>}
  </section>;
}

function DocumentsPanel() {
  const [documents,setDocuments]=useState<DocumentRecord[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{try{setDocuments((await apiGet<{documents:DocumentRecord[]}>('/api/admin/documents')).documents);}catch(e){setError(e instanceof Error?e.message:'Falha ao carregar documentos.');}},[]);
  useEffect(()=>{void load();},[load]);
  return <section className="document-panel"><h2>Fiscal e jurídico</h2><p>A emissão automática de NFC-e ainda não está integrada. Vincule o documento emitido pelo sistema fiscal e os documentos jurídicos do evento. Os links cadastrados não têm autenticidade fiscal verificada pelo aplicativo.</p><p><a href="https://sped.fazenda.pr.gov.br/NFCe/Pagina/Apresentacao" target="_blank" rel="noopener noreferrer">NFC-e na Receita Estadual do Paraná</a> · A emissão depende do responsável fiscal, da UF e do credenciamento do emitente.</p>
    <details><summary>Vincular documento existente</summary><form className="document-form" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;const values=new FormData(form);setBusy(true);try{await apiPost('/api/admin/documents',Object.fromEntries(values));form.reset();setError('');await load();}catch(err){setError(err instanceof Error?err.message:'Falha ao vincular.');}finally{setBusy(false);}}}>
      <label className="field"><span>Tipo</span><select name="kind"><option value="FISCAL">Documento fiscal de pedido pago</option><option value="LEGAL">Documento jurídico do evento</option></select></label><label className="field"><span>Título</span><input name="title" required maxLength={150} placeholder="NFC-e ou contrato do evento"/></label><label className="field"><span>Número do pedido (obrigatório para fiscal)</span><input name="orderNumber"/></label><label className="field"><span>Link HTTPS do documento</span><input name="url" type="url" required placeholder="https://…"/></label><button className="primary-button" disabled={busy}>{busy?'Salvando…':'Vincular documento'}</button></form></details>
    {error&&<div className="error-box">{error}</div>}<div className="management-cards">{documents.map(d=><article className="management-card" key={d.id}><small>{d.kind==='FISCAL'?'Fiscal':'Jurídico'}</small><h3>{d.title}</h3>{d.orderNumber&&<p className="order-reference">Pedido {d.orderNumber}</p>}<a className="secondary-button" href={d.url} target="_blank" rel="noopener noreferrer">Abrir documento</a></article>)}</div>{!documents.length&&<p className="muted">Nenhum documento vinculado.</p>}
  </section>;
}

export function TeamPanel() {
  const [members,setMembers]=useState<Array<{id:string;name:string;role:string;active:number;devices:number;readings:number;registeredAt:string}>>([]);
  const [error,setError]=useState('');
  const load=useCallback(async()=>{try{setMembers((await apiGet<{members:typeof members}>('/api/admin/team')).members);setError('');}catch(e){setError(e instanceof Error?e.message:'Falha ao consultar equipe.');}},[]);
  useEffect(()=>{void load();},[load]);
  return <section><div className="dashboard-heading"><div><span className="eyebrow">ACESSO DA EQUIPE</span><h1>Quem tem acesso</h1></div><button className="ghost-button" onClick={()=>void load()}>Atualizar</button></div><p>Os leitores entram pelo link de leitura e informam o nome. O nome é uma identificação; a autorização vem do link privado. Administradores usam o acesso administrativo.</p>{error&&<div className="error-box">{error}</div>}<div className="management-cards">{members.map(m=><article className="management-card" key={m.id}><div className="management-card__head"><h3>{m.name}</h3><span className="order-badge">{m.active?'Cadastrado':'Desativado'}</span></div><p>{m.role==='ADMIN'?'Administrador · acesso ao admin':m.role==='MARKETING'?'Marketing · cupons': 'Leitura de QR codes'}</p><p>{m.devices} acessos válidos · {m.readings} fichas validadas</p><small>Cadastro {formatDate(m.registeredAt)}</small></article>)}</div></section>;
}

interface Analysis {averageTicket:number;summary:{revenueCents:number;paidOrders:number;paidUnits:number;courtesyUnits:number};products:Array<{productName:string;paidUnits:number;courtesyUnits:number;revenueCents:number}>;pareto:Array<{productName:string;paidUnits:number;revenueCents:number;share:number;cumulative:number;priority:boolean}>;access:{browsers:number;since:string|null};hourly:Array<{hour:string;orders:number;revenue:number}>}
export function ResultsAnalysis() {
  const [data,setData]=useState<Analysis|null>(null);
  const [error,setError]=useState('');
  const load=useCallback(async()=>{try{setData(await apiGet('/api/admin/analytics'));setError('');}catch(e){setError(e instanceof Error?e.message:'Falha na análise.');}},[]);
  useEffect(()=>{void load();},[load]);
  const top=data?[...data.products].filter(p=>p.paidUnits>0).sort((a,b)=>b.paidUnits-a.paidUnits)[0]:null;
  return <section className="results-analysis"><div className="dashboard-heading"><div><span className="eyebrow">ANÁLISE DOS RESULTADOS</span><h1>O que o evento mostra</h1></div><div className="report-heading-actions"><button className="ghost-button" onClick={()=>void load()}>Atualizar</button><a className="primary-button" href="/api/admin/reports/csv">Baixar base CSV</a></div></div>{error&&<div className="error-box">{error}</div>}{data&&<><div className="metric-grid"><article className="metric-card"><span>Ticket médio por pedido pago</span><strong>{money(data.averageTicket)}</strong></article><article className="metric-card"><span>Acessos únicos ao cardápio</span><strong>{data.access.browsers}</strong></article><article className="metric-card"><span>Mais vendido · unidades pagas</span><strong>{top?.productName??'Sem vendas'}</strong><small>{top?`${top.paidUnits} unidades`:''}</small></article><article className="metric-card"><span>Cortesias emitidas</span><strong>{data.summary.courtesyUnits}</strong></article></div><p className="muted">Acessos contam navegadores, não pessoas presentes. Medição {data.access.since?`desde ${formatDate(data.access.since)}`:'iniciada com esta versão; ainda sem acessos'}. Vendas de teste também entram nas análises locais. Ticket médio = receita bruta paga ÷ pedidos pagos, sem cortesias.</p>
      <div className="analysis-card"><h2>Pareto de faturamento</h2><p>As bebidas em destaque compõem os primeiros 80% da receita, incluindo o item que cruza esse limite.</p>{data.pareto.length>0&&<ParetoChart rows={data.pareto}/>}{data.pareto.map(p=><div className="pareto-row" key={p.productName}><div><b>{p.productName}</b><span>{money(p.revenueCents)} · {p.share.toFixed(1)}%</span></div><div className="analysis-track"><span style={{width:`${p.share}%`}} className={p.priority?'priority':''}/></div><small>Acumulado {p.cumulative.toFixed(1)}%{p.priority?' · prioridade':''}</small></div>)}{!data.pareto.length&&<p>O Pareto aparece quando houver vendas pagas.</p>}</div>
      <div className="analysis-card"><h2>Bebidas vendidas e cortesias</h2>{data.products.map(p=><div className="pareto-row" key={p.productName}><div><b>{p.productName}</b><span>{p.paidUnits} pagas · {p.courtesyUnits} cortesias</span></div><div className="analysis-track"><span style={{width:`${p.paidUnits/Math.max(1,...data.products.map(v=>v.paidUnits))*100}%`}}/></div></div>)}</div>
      <div className="analysis-card"><h2>Vendas por hora</h2><p>Horário de Brasília · confirmação do pagamento</p>{data.hourly.map(h=><div className="pareto-row" key={h.hour}><div><b>{h.hour}</b><span>{h.orders} pedidos · {money(h.revenue)}</span></div><div className="analysis-track"><span style={{width:`${h.revenue/Math.max(1,...data.hourly.map(v=>v.revenue))*100}%`}}/></div></div>)}{!data.hourly.length&&<p>Aguardando pedidos pagos.</p>}</div>
      <div className="analysis-card"><h2>Previsibilidade dos próximos eventos</h2><p>Para estimar compras com o Bruno, vamos cruzar público real, consumo por pessoa, duração, custo e perdas. Rupturas de estoque e cortesias precisam entrar na conta para não subestimar a demanda.</p><p>O modelo de Excel está estruturado no projeto para discussão. Os relatórios abaixo exportam a base atual; ainda precisamos alinhar os custos, a composição dos combos e o público real.</p></div>
    </>}</section>;
}


function ParetoChart({rows}:{rows:Analysis['pareto']}) {
  const step=460/rows.length;
  const x=(i:number)=>40+step*(i+.5);
  const y=(percentage:number)=>190-percentage*1.6;
  return <><svg viewBox="0 0 540 230" role="img" aria-label="Pareto: barras mostram a receita de cada bebida e a linha mostra o percentual acumulado" style={{width:'100%',height:'auto'}}>
    <line x1="30" x2="510" y1={y(80)} y2={y(80)} stroke="#aaa" strokeDasharray="4 4"/><text x="510" y={y(80)-5} fontSize="12" fill="#666">80%</text>
    {rows.map((r,i)=><g key={r.productName}><rect x={x(i)-step*.32} y={y(r.share)} width={step*.64} height={r.share*1.6} fill={r.priority?'#ff6508':'#9195a0'}/><text x={x(i)} y="211" textAnchor="middle" fontSize="12" fill="#444">{i+1}</text></g>)}
    <polyline points={rows.map((r,i)=>`${x(i)},${y(r.cumulative)}`).join(' ')} fill="none" stroke="#202027" strokeWidth="3"/>
    {rows.map((r,i)=><circle key={r.productName} cx={x(i)} cy={y(r.cumulative)} r="4" fill="#202027"/>)}
  </svg><p className="muted">Barras: participação na receita. Linha: acumulado. A ordem dos produtos está na lista abaixo.</p></>;
}
