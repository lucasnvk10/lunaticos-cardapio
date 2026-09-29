# Cardápio online e fichas digitais

Sistema web para um evento próprio, com cardápio, Pix, fichas individuais, scanner, estoque, cortesias e painel operacional. O projeto usa somente serviços com opção gratuita e não depende do Buddy.

## Arquitetura

- React, Vite e TypeScript no navegador.
- Cloudflare Worker para `/api/*`.
- Cloudflare Workers Static Assets para o site.
- Cloudflare D1 para os dados.
- PagBank para Pix e webhooks.
- Modo `mock` para desenvolvimento sem credenciais financeiras.

## Rodar localmente

No PowerShell, dentro desta pasta:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\Initialize-Local.ps1
npm run dev:full
```

Abra `http://localhost:8787`. O script cria `.dev.vars` com chaves locais aleatórias, aplica o banco, inclui os produtos de demonstração e gera o site.

Para criar a primeira conta administrativa, entre em `http://localhost:8787/equipe` e defina o nome, o usuário e uma senha com pelo menos 10 caracteres. A criação inicial fica disponível apenas enquanto não existir uma conta; a primeira inscrição válida ocupa essa vaga.

Depois disso, o painel passa a aceitar diretamente o usuário e a senha criados. As senhas são armazenadas no D1 com PBKDF2/SHA-256, salt exclusivo e 210 mil iterações. Cinco tentativas incorretas no mesmo endereço bloqueiam novas tentativas por 15 minutos.

No modo simulado, um pedido pode ser aprovado pela rota abaixo usando uma sessão administrativa:

```text
POST /api/dev/mock/orders/{publicId}/approve
```

## Comandos

```powershell
npm run build
npm test
npm run dev:full
npm run db:migrate:local
npm run db:seed:local
```

O teste de carga usa o k6 instalado localmente:

```powershell
k6 run -e BASE_URL=http://localhost:8787 .\load-tests\event.js
```

O cenário completo cria 300 pedidos. Use um banco descartável ou restaure o banco local depois do teste.

## Configurar PagBank

Use primeiro o sandbox. Nunca coloque tokens no código ou no Git.

1. Altere `PAYMENTS_MODE` para `pagbank` no ambiente desejado.
2. Cadastre os secrets `PAGBANK_TOKEN`, `PAGBANK_WEBHOOK_PUBLIC_KEY` e `TOKEN_ENCRYPTION_KEY` com `npx wrangler secret put NOME`.
3. Confirme `PAGBANK_API_BASE_URL`, `APP_ORIGIN` e a URL de webhook.
4. Faça uma compra de baixo valor e confira pedido, webhook, fichas e retirada.

O Worker valida `x-payload-signature` com ECDSA/SHA-256 antes de processar uma notificação. Confirme na homologação se a conta PagBank está usando esse formato atual de assinatura.

## Publicar gratuitamente

1. Crie uma conta Cloudflare sem ativar plano pago.
2. Crie o D1: `npx wrangler d1 create fichas-evento`.
3. Substitua o `database_id` em `wrangler.jsonc` pelo identificador retornado.
4. Aplique as migrations: `npx wrangler d1 migrations apply DB --remote`.
5. Aplique `db/seed.sql` somente após revisar nome, produtos, preços e estoques.
6. Cadastre todos os secrets.
7. Troque `APP_ORIGIN` pelo endereço `workers.dev` final e defina `PAYMENTS_MODE=pagbank`.
8. Execute `npm run deploy`.

## Antes do evento

- Substituir os produtos e estoques de demonstração.
- Testar o PagBank no sandbox e em produção com valor baixo.
- Criar e ativar todos os aparelhos.
- Exportar uma cópia do D1.
- Executar o teste de carga em outro dia para preservar as cotas do evento.
- Ensaiar com a rede principal e a rede reserva no local.
- Conferir a tela **Equipe > Saúde** e o painel de uso da Cloudflare.

## Limites operacionais

Arquivos estáticos não consomem a cota de Worker. Chamadas de API são planejadas para ficar abaixo de 70 mil por dia, preservando margem dentro do plano gratuito. O painel interno mostra uma estimativa; o número oficial deve ser conferido no painel Cloudflare.

A infraestrutura tem custo fixo zero, mas o PagBank pode cobrar tarifa por transação Pix.

## Estoque por volume e avisos no celular

Em **Evento > Estoque e bebidas**, informe unidades, litros ou mililitros. Para líquidos, defina o tamanho do copo em ml. O servidor calcula apenas copos completos: 60 L / 500 ml = 120 fichas; 60 L / 440 ml = 136 fichas. Reposição e perda preservam as sobras de volume. A porção e o estoque inicial ficam protegidos após movimentações; use reposição/perda durante a operação.

Reservas Pix, vendas e cortesias comprometem o mesmo saldo. Retirar uma ficha não desconta a venda outra vez. Saldo zero impede novas compras no servidor, inclusive com cardápio desatualizado. Os avisos distinguem estoque baixo, saldo reservado e esgotamento, com histórico e botão **Ciente**.

Para ensaiar push no ambiente local:

```powershell
node scripts/Configure-LocalPush.cjs
npm.cmd run db:migrate:local
npm.cmd run dev:full
```

O script gera chaves somente em `.dev.vars`, sem imprimi-las. Reinicie o servidor depois da configuração e de um novo build. Use Chrome com perfil normal, pois push não funciona no modo anônimo. Na gestão, abra **Notificações e histórico > Ativar push neste celular**. Para a moldura de celular, abra `http://localhost:8787/celular.html`; gestão direta: `http://localhost:8787/equipe?view=stock`.

Em produção, configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` nos secrets do Worker. `VAPID_SUBJECT` deve conter um contato real (`mailto:` ou HTTPS); o contato de demonstração local não é configuração de produção. Publique em HTTPS e valide nos celulares do evento. No iPhone, abra pelo app adicionado à tela de início. Referência: [Web Push para apps na tela de início](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

O push chega a todos os administradores com inscrição ativa e sessão válida. Sem confirmação de ciência, há até três tentativas, com intervalo mínimo de dois minutos. Aceite pelo serviço push não significa leitura; o navegador pode informar recebimento, e **Ciente** registra confirmação humana. O bloqueio das vendas independe da entrega do aviso. No desenvolvimento local, cron não roda automaticamente; para ensaiar expiração de reservas e novas tentativas, chame `http://localhost:8787/cdn-cgi/local/scheduled`. Na publicação, a configuração existente executa o cron a cada minuto.

Ligação automática, estoque compartilhado por vários tamanhos de copo e margem percentual de perda ainda não estão integrados. Cada produto usa estoque próprio; registre perdas explicitamente.
