// Creates local-only VAPID credentials without printing private keys.
const fs = require('node:fs');
const path = require('node:path');
const webPush = require('web-push');
const target = path.join(__dirname, '..', '.dev.vars');
const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
if (/^VAPID_PUBLIC_KEY=/m.test(current) || /^VAPID_PRIVATE_KEY=/m.test(current)) {
  console.log('As chaves locais de push ja existem. Nenhuma chave foi substituida.');
} else {
  const keys = webPush.generateVAPIDKeys();
  fs.appendFileSync(target, `${current.endsWith('\n') || !current ? '' : '\n'}VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=mailto:local@example.invalid\n`);
  console.log('Push configurado apenas no ambiente local. Reinicie o servidor.');
}
