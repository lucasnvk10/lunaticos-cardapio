import { useEffect, useRef, useState } from 'react';
import type { DashboardData } from '../pages/StaffPage';
import { apiPost, money } from '../lib/api';
import { ProductVisual } from './ProductVisual';

type Product = DashboardData['products'][number];
function needsAttention(p:Product) { return Boolean(p.active) && p.available_quantity <= p.low_stock_threshold; }
function stockStatus(p:Product) {
  if(!p.active) return 'Suspenso';
  if(p.available_quantity===0) return p.reserved_quantity>0?'Reservado':p.initial_quantity+p.adjustment_quantity>0?'Esgotado':'Sem estoque';
  return needsAttention(p)?'Estoque baixo':'Disponível';
}
function stockRank(p:Product) { return !p.active?3:p.available_quantity===0?0:needsAttention(p)?1:2; }

function StockFields({ defaultUnit = 'UNIT', defaultAmount = 0, defaultPortion = 500, defaultThreshold = 10 }: {
  defaultUnit?: string; defaultAmount?: number; defaultPortion?: number; defaultThreshold?: number;
}) {
  const [unit, setUnit] = useState(defaultUnit);
  const [amount, setAmount] = useState(defaultAmount);
  const [portion, setPortion] = useState(defaultPortion || 500);
  const capacity = unit === 'UNIT' ? Math.floor(amount) : Math.floor(amount * (unit === 'L' ? 1000 : 1) / portion);
  return <>
    <label className="field"><span>Medida do estoque</span><select name="stockUnit" value={unit} onChange={e => setUnit(e.target.value)}><option value="UNIT">Unidades</option><option value="L">Litros</option><option value="ML">Mililitros</option></select></label>
    <label className="field"><span>Estoque inicial ({unit === 'L' ? 'litros' : unit === 'ML' ? 'ml' : 'unidades'})</span><input name="stockAmount" type="number" inputMode="decimal" required min="0" max={unit === 'L' ? 100000 : unit === 'ML' ? 100000000 : 100000} step={unit === 'L' ? '0.001' : '1'} value={amount} onChange={e => setAmount(Number(e.target.value))} /></label>
    {unit !== 'UNIT' && <label className="field"><span>Tamanho do copo (ml)</span><input name="portionMl" type="number" inputMode="numeric" required min="1" max="10000" step="1" value={portion} onChange={e => setPortion(Number(e.target.value))} /></label>}
    <label className="field"><span>Avisar quando restarem (fichas)</span><input name="lowStockThreshold" type="number" inputMode="numeric" required min="0" max="100000" defaultValue={defaultThreshold} /></label>
    <div className="stock-capacity field--wide"><strong>{Number.isFinite(capacity) ? capacity : 0}</strong><span>{unit === 'UNIT' ? 'unidades disponíveis para fichas' : `copos completos de ${portion} ml`}</span></div>
  </>;
}

function stockInput(form: HTMLFormElement) {
  const values = new FormData(form);
  return { stockUnit: String(values.get('stockUnit')), stockAmount: Number(values.get('stockAmount')),
    portionMl: Number(values.get('portionMl')), lowStockThreshold: Number(values.get('lowStockThreshold')) };
}

export function StockManager({ products, onChanged }: { products: DashboardData['products']; onChanged: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<'all'|'attention'|'available'|'paused'>('all');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const selected=products.find(p=>p.id===selectedId);
  const normalizedQuery=query.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const visible=products.filter(p=>p.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(normalizedQuery))
    .filter(p=>filter==='all'||filter==='attention'&&needsAttention(p)||filter==='available'&&p.active&&p.available_quantity>0||filter==='paused'&&!p.active)
    .sort((a,b)=>stockRank(a)-stockRank(b));
  const attention=products.filter(needsAttention).length;
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setError('');
    try {
      await apiPost('/api/admin/products', { name: values.get('name'), description: values.get('description'), price: Number(values.get('price')), ...stockInput(form) });
      setAddOpen(false); await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível cadastrar.'); }
    finally { setBusy(false); }
  }
  return <section className="stock-manager">
    <div className="dashboard-heading"><div><span className="eyebrow">ESTOQUE DO EVENTO</span><h1>Estoque de bebidas</h1><p className="stock-intro">Veja o saldo. Toque na bebida para repor ou ajustar.</p></div><button className="secondary-button stock-add" onClick={() => setAddOpen(!addOpen)}>{addOpen ? 'Fechar cadastro' : '+ Bebida'}</button></div>
    <div className="stock-summary"><div><strong>{products.filter(p=>p.active&&p.available_quantity>0).length}</strong><span>Com saldo</span></div><div className={attention?'stock-summary--attention':''}><strong>{attention}</strong><span>Precisam de atenção</span></div><div><strong>{products.filter(p=>!p.active).length}</strong><span>Suspensas</span></div></div>
    <label className="stock-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Buscar bebida no estoque" placeholder="Buscar bebida…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <nav className="stock-filters" aria-label="Filtrar estoque">{([{id:'all',label:'Todas'},{id:'attention',label:`Atenção (${attention})`},{id:'available',label:'Com saldo'},{id:'paused',label:'Suspensas'}] as const).map(f=><button key={f.id} type="button" aria-pressed={filter===f.id} onClick={()=>setFilter(f.id)}>{f.label}</button>)}</nav>
    {error && <div className="error-box" role="alert">{error}</div>}
    {addOpen && <form className="stock-form" onSubmit={add}><h2>Nova bebida</h2><label className="field"><span>Nome da bebida</span><input name="name" required maxLength={80} /></label><label className="field"><span>Preço (R$)</span><input name="price" type="number" inputMode="decimal" min="0.01" max="100000" step="0.01" required /></label><label className="field field--wide"><span>Descrição</span><input name="description" maxLength={240} /></label><StockFields /><button className="primary-button field--wide" disabled={busy}>{busy ? 'Salvando…' : 'Cadastrar bebida e estoque'}</button></form>}
    <p className="stock-list-label">{visible.length} {visible.length===1?'bebida':'bebidas'} · alertas primeiro</p>
    <div className="stock-visual-grid">{visible.map(p=>{
      const capacity=p.initial_quantity+p.adjustment_quantity;
      return <button className={`stock-tile ${needsAttention(p)?'stock-tile--attention':''} ${!p.active?'stock-tile--paused':''}`} key={p.id} onClick={()=>setSelectedId(p.id)} aria-label={`Gerenciar estoque de ${p.name}`}>
        <span className={`stock-tile-status ${needsAttention(p)?'stock-tile-status--attention':''}`}>{stockStatus(p)}</span>
        <div className="stock-tile-image"><ProductVisual slug={p.slug} name={p.name} emoji={p.emoji}/></div>
        <h2>{p.name}</h2><span className="stock-tile-price">{money(p.unit_price_cents)}{p.portion_ml>0?` · ${p.portion_ml} ml`:''}</span>
        <div className="stock-tile-balance"><strong>{p.available_quantity}</strong><span>{!p.active?'saldo suspenso':p.stock_unit==='UNIT'?'unid. para vender':'copos para vender'}</span></div>
        <progress aria-label={`Saldo disponível de ${p.name}`} max={Math.max(1,capacity)} value={p.available_quantity}/>
        <span className="stock-tile-footer">{p.stock_unit==='UNIT'?`de ${capacity} unidades`:`${(p.available_quantity*p.portion_ml/1000).toLocaleString('pt-BR')} L em copos completos`}<b aria-hidden="true">↗</b></span>
      </button>;
    })}</div>
    {!visible.length&&<div className="stock-empty"><h2>Nenhuma bebida encontrada</h2><p>Tente outro nome ou veja todas as bebidas.</p><button className="secondary-button" onClick={()=>{setQuery('');setFilter('all');}}>Mostrar todas</button></div>}
    <p className="stock-auto-note">Ao zerar o saldo, novas vendas são bloqueadas automaticamente.</p>
    {selected&&<StockDialog product={selected} onClose={()=>setSelectedId(null)} onChanged={onChanged}/>}
  </section>;
}

function StockDialog({product,onClose,onChanged}:{product:Product;onClose:()=>void;onChanged:()=>Promise<void>}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const dialog=ref.current!;dialog.showModal();
    const previous=document.body.style.overflow;document.body.style.overflow='hidden';
    return ()=>{dialog.close();document.body.style.overflow=previous;if(trigger?.isConnected)trigger.focus({preventScroll:true});};
  },[]);
  return <dialog className="stock-dialog" ref={ref} aria-label={`Estoque de ${product.name}`} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget){const rect=e.currentTarget.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)onClose();}}}>
    <div className="stock-dialog-top"><span>GERENCIAR BEBIDA</span><button className="ghost-button" aria-label="Fechar ajustes da bebida" onClick={onClose}>Fechar ×</button></div>
    <StockCard product={product} onChanged={onChanged}/>
  </dialog>;
}

function StockCard({ product: p, onChanged }: { product: DashboardData['products'][number]; onChanged: () => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'settings' | 'adjust' | 'price' | null>(null);
  const [adjustType, setAdjustType] = useState<'add' | 'loss'>('add');
  const unitLabel = p.stock_unit === 'L' ? 'litros' : p.stock_unit === 'ML' ? 'ml' : 'unidades';
  const capacity = p.initial_quantity + p.adjustment_quantity;
  const emitted = p.sold_quantity + p.courtesy_quantity;
  const status = !p.active ? 'Suspenso' : p.available_quantity === 0 ? (p.reserved_quantity > 0 ? 'Todo o saldo reservado' : 'Esgotado') : p.available_quantity <= p.low_stock_threshold ? 'Está acabando' : 'Disponível';
  const danger = p.active && p.available_quantity <= p.low_stock_threshold;
  const hasActivity = emitted > 0 || p.reserved_quantity > 0 || p.redeemed_quantity > 0 || p.adjustment_quantity !== 0 || p.adjustment_volume_ml !== 0;
  async function run(path: string, body: unknown) {
    setBusy(true); setError('');
    try { await apiPost(`/api/admin/products/${p.id}/${path}`, body); setAction(null); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  }
  return <article className={`stock-card ${danger ? 'stock-card--attention' : ''}`}>
    <div className="stock-card-heading"><div className="stock-detail-image"><ProductVisual slug={p.slug} name={p.name} emoji={p.emoji}/></div><div className="stock-detail-title"><h2>{p.name}</h2><span>{money(p.unit_price_cents)}{p.portion_ml > 0 ? ` · copo de ${p.portion_ml} ml` : ' · por unidade'}</span><span className={`stock-status ${danger ? 'stock-status--attention' : ''}`}>{status}</span></div></div>
    <div className="stock-balance"><strong>{p.available_quantity}</strong><div><b>{p.stock_unit === 'UNIT' ? 'unidades para vender' : 'copos para vender'}</b><span>{p.stock_unit !== 'UNIT' ? `${(p.available_quantity * p.portion_ml / 1000).toLocaleString('pt-BR')} L disponíveis em copos completos` : `de ${capacity} unidades cadastradas`}</span></div></div>
    <progress aria-label={`Saldo disponível de ${p.name}`} max={Math.max(1, capacity)} value={p.available_quantity} />
    <dl className="stock-counts"><div><dt>Fichas emitidas</dt><dd>{emitted}</dd></div><div><dt>Reservas Pix</dt><dd>{p.reserved_quantity}</dd></div><div><dt>Já retiradas</dt><dd>{p.redeemed_quantity}</dd></div></dl>
    {p.stock_unit !== 'UNIT' && <p className="stock-physical">Físico esperado: {((p.initial_volume_ml + p.adjustment_volume_ml - p.redeemed_quantity * p.portion_ml) / 1000).toLocaleString('pt-BR')} L. Inclui bebidas de fichas ainda não retiradas.</p>}
    {p.available_quantity === 0 && <p className="stock-blocked">{p.reserved_quantity > 0 ? 'Novas vendas bloqueadas. Um Pix expirado pode liberar saldo.' : 'Novas vendas bloqueadas. Faça uma reposição para liberar saldo.'}</p>}
    <div className="stock-card-actions"><button className="secondary-button" disabled={busy} onClick={() => { setAdjustType('add'); setAction(action === 'adjust' && adjustType === 'add' ? null : 'adjust'); }}>+ Reposição</button><button className="secondary-button" disabled={busy} onClick={() => { setAdjustType('loss'); setAction(action === 'adjust' && adjustType === 'loss' ? null : 'adjust'); }}>Registrar perda</button></div>
    <details className="stock-options"><summary>Configuração e preço</summary><div className="stock-card-actions"><button className="ghost-button" disabled={hasActivity || busy} onClick={() => setAction('settings')}>Definir estoque e copo</button><button className="ghost-button" disabled={busy} onClick={() => setAction('price')}>Editar preço</button><button className="ghost-button" disabled={busy} onClick={() => void run('active', { active: !p.active })}>{p.active ? 'Suspender vendas' : 'Reativar item'}</button></div>{hasActivity && <p className="form-help">Estoque inicial e tamanho do copo ficam fixos após movimentações. Use reposição ou perda.</p>}</details>
    {error && <div className="error-box" role="alert">{error}</div>}
    {action === 'settings' && <form className="stock-form stock-form--inner" onSubmit={e => { e.preventDefault(); void run('stock-settings', stockInput(e.currentTarget)); }}><h3>Estoque e porção</h3><StockFields defaultUnit={p.stock_unit} defaultAmount={p.stock_unit === 'UNIT' ? p.initial_quantity : p.initial_volume_ml / (p.stock_unit === 'L' ? 1000 : 1)} defaultPortion={p.portion_ml} defaultThreshold={p.low_stock_threshold} /><button className="primary-button field--wide" disabled={busy}>Salvar configuração</button></form>}
    {action === 'adjust' && <form className="stock-form stock-form--inner" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const quantity = Number(f.get('amount')) * (adjustType === 'loss' ? -1 : 1); void run('stock', { [p.stock_unit === 'UNIT' ? 'quantity' : 'volumeAmount']: quantity, reason: String(f.get('reason')) }); }}><h3>{adjustType === 'add' ? 'Adicionar reposição' : 'Registrar perda'}</h3><label className="field"><span>Quantidade ({unitLabel})</span><input name="amount" type="number" inputMode="decimal" min={p.stock_unit === 'L' ? '0.001' : '1'} step={p.stock_unit === 'L' ? '0.001' : '1'} required /></label><label className="field"><span>Motivo</span><input name="reason" maxLength={250} placeholder={adjustType === 'add' ? 'Novo barril' : 'Derramamento'} required /></label><button className="primary-button field--wide" disabled={busy}>Salvar {adjustType === 'add' ? 'reposição' : 'perda'}</button></form>}
    {action === 'price' && <form className="stock-form stock-form--inner" onSubmit={e => { e.preventDefault(); void run('price', { price: Number(new FormData(e.currentTarget).get('price')) }); }}><label className="field"><span>Novo preço (R$)</span><input name="price" type="number" inputMode="decimal" min="0.01" max="100000" step="0.01" defaultValue={(p.unit_price_cents / 100).toFixed(2)} required /></label><button className="primary-button" disabled={busy}>Salvar preço</button></form>}
  </article>;
}
