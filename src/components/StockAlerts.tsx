import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, formatDate } from '../lib/api';

interface StockAlert { id: string; product_name: string; kind: 'LOW' | 'RESERVED' | 'EXHAUSTED'; available_quantity: number; capacity: number; committed_quantity: number; created_at: string; resolved_at: string | null; acknowledged_at: string | null; acknowledged_name: string | null; push_accepted: number; push_received: number; push_failed: number }
interface AlertData { alerts: StockAlert[]; pushConfigured: boolean; publicKey: string | null; subscribed: boolean }

export function StockAlerts() {
  const [data, setData] = useState<AlertData | null>(null); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [sound, setSound] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const audio = useRef<AudioContext | null>(null); const seen = useRef(new Set<string>());
  useEffect(() => { if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {}); }, []);
  const load = useCallback(async () => {
    try {
      const next = await apiGet<AlertData>('/api/admin/stock-alerts');
      const current = next.alerts.filter(a => !a.resolved_at && !a.acknowledged_at);
      if (sound && current.some(a => !seen.current.has(a.id)) && audio.current?.state === 'running') {
        const oscillator = audio.current.createOscillator(); const gain = audio.current.createGain();
        oscillator.frequency.value = 880; gain.gain.value = 0.15;
        oscillator.connect(gain); gain.connect(audio.current.destination); oscillator.start(); oscillator.stop(audio.current.currentTime + 0.35);
      }
      seen.current = new Set(current.map(a => a.id)); setData(next); setLastUpdate(Date.now()); setError('');
    } catch { setError('Sem atualização dos avisos. Verifique a conexão; o bloqueio de estoque continua no servidor.'); }
  }, [sound]);
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10000); const visible = () => { if (document.visibilityState === 'visible') void load(); }; document.addEventListener('visibilitychange', visible); return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); }; }, [load]);
  useEffect(() => () => { void audio.current?.close(); }, []);
  async function enablePush() {
    setBusy(true); setError('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Este navegador não oferece push. No iPhone, adicione o app à tela de início e abra por lá.');
      if (Notification.permission === 'denied') throw new Error('Notificações bloqueadas. Libere este site nas configurações do navegador.');
      if (await Notification.requestPermission() !== 'granted') throw new Error('Permissão não concedida. Os avisos continuam aqui na gestão.');
      if (!data?.publicKey) throw new Error('Push ainda não configurado no servidor.');
      const registration = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
      const bytes = Uint8Array.from(atob(data.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await apiPost('/api/admin/push-subscriptions', subscription.toJSON()); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível ativar notificações.'); }
    finally { setBusy(false); }
  }
  async function disablePush() {
    setBusy(true); try { await apiPost('/api/admin/push-subscriptions/disable'); const reg = await navigator.serviceWorker.getRegistration(); await (await reg?.pushManager.getSubscription())?.unsubscribe(); await load(); } catch { setError('Não foi possível desativar. Tente novamente.'); } finally { setBusy(false); }
  }
  async function acknowledge(id: string) {
    setBusy(true); try { await apiPost(`/api/admin/stock-alerts/${id}/acknowledge`); await load(); } catch { setError('Não foi possível confirmar ciência. Tente novamente.'); } finally { setBusy(false); }
  }
  const pending = data?.alerts.filter(a => !a.resolved_at && !a.acknowledged_at) ?? [];
  return <aside className={`stock-alerts ${pending.length ? 'stock-alerts--urgent' : ''}`} aria-label="Avisos de estoque">
    <div className="stock-alerts-heading"><div><span className="eyebrow">AVISOS DA OPERAÇÃO</span><h2>{pending.length ? `${pending.length} ${pending.length === 1 ? 'item precisa' : 'itens precisam'} de atenção` : 'Estoque acompanhado'}</h2></div><span className="stock-alert-count">{pending.length}</span></div>
    {error && <p className="error-box" role="alert">{error}</p>}
    <div aria-live="polite">{pending.map(a => <article className={`stock-alert stock-alert--${a.kind.toLowerCase()}`} key={a.id}><strong>{a.product_name}: {a.kind === 'LOW' ? 'está acabando' : a.kind === 'RESERVED' ? 'saldo reservado' : 'esgotado'}</strong><p>{a.kind === 'LOW' ? `Restam ${a.available_quantity} fichas para venda.` : a.kind === 'RESERVED' ? 'Todo o saldo está comprometido. Novas vendas bloqueadas até liberar uma reserva ou repor estoque.' : `${a.committed_quantity} de ${a.capacity} porções comprometidas. Novas vendas bloqueadas automaticamente.`}</p><small>{formatDate(a.created_at)}{a.push_received > 0 ? ' \u00b7 Aviso recebido no navegador' : a.push_accepted > 0 ? ' \u00b7 Push aceito pelo servi\u00e7o; aguardando recebimento' : ''}{a.push_failed > 0 ? ' \u00b7 Falha no push; confira os celulares cadastrados' : ''}</small><button className="secondary-button" disabled={busy} onClick={() => void acknowledge(a.id)}>Ciente</button></article>)}</div>
    <details className="stock-alert-settings"><summary>Notificações e histórico</summary><p className="form-help">Ative nos celulares dos responsáveis. Sem confirmação de ciência, o push é repetido até três vezes, com intervalo mínimo de dois minutos. Confirmar não reabre vendas.</p><div className="stock-card-actions"><button className="secondary-button" disabled={busy || !data?.pushConfigured} onClick={() => void (data?.subscribed ? disablePush() : enablePush())}>{data?.subscribed ? 'Desativar push neste celular' : 'Ativar push neste celular'}</button><button className="secondary-button" onClick={async () => { if (!sound) { audio.current ??= new AudioContext(); await audio.current.resume(); } setSound(!sound); }}>{sound ? 'Silenciar som na gestão' : 'Ativar som na gestão'}</button></div>{!data?.pushConfigured && <p className="form-help">Push ainda não configurado neste ambiente. Avisos na gestão estão disponíveis.</p>}<p className="form-help">Som funciona enquanto a gestão estiver aberta. Última atualização: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString('pt-BR') : 'aguardando conexão'}.</p>{data?.alerts.filter(a => a.acknowledged_at || a.resolved_at).slice(0, 10).map(a => <p className="stock-alert-history" key={a.id}><strong>{a.product_name}</strong> · {a.kind === 'LOW' ? 'estoque baixo' : a.kind === 'RESERVED' ? 'saldo reservado' : 'esgotado'}<br />{a.acknowledged_at ? `Ciente: ${a.acknowledged_name} às ${formatDate(a.acknowledged_at)}` : 'Saldo alterado; ocorrência encerrada.'}</p>)}</details>
  </aside>;
}
