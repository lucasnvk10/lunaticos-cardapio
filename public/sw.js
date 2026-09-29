self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No offline caching: stock and ticket availability must always come from the server.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* safe default */ }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title ?? 'Aviso de estoque', {
    body: data.body ?? 'Abra a gestão para conferir o estoque do evento.',
    icon: '/brand/lunaticos-mark.png', tag: data.tag ?? 'stock-alert',
    renotify: true, requireInteraction: true, data: { url: '/equipe' }
    });
    if (data.tag) {
      try { await fetch('/api/admin/push-receipts', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alertId: data.tag }) }); } catch { /* The persistent alert still requires human acknowledgement. */ }
    }
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) { await client.navigate('/equipe'); return client.focus(); }
    }
    return self.clients.openWindow('/equipe');
  })());
});
