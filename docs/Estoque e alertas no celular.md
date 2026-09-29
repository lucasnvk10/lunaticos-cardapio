# Estoque e alertas no celular

Estrutura definida a partir da conversa de 28/09/2026. A implementação local foi iniciada e validada conforme o registro ao fim deste documento. As propostas de extensão continuam identificadas como propostas.

## Direção do produto

O sistema de eventos e sua gestão devem ser pensados primeiro para celular, com adaptação para computador. A tarefa principal da gestão é configurar o cardápio do evento, informar quanto existe de cada produto e acompanhar quanto ainda pode ser vendido.

O sistema deve bloquear novas vendas quando todo o estoque estiver comprometido, sem depender de alguém suspender a bebida manualmente. Também deve avisar o responsável pelo evento.

## Cadastro simples

Cada item do cardápio deve ter nome, preço e estoque definido. Para líquidos, informar litros ou mililitros disponíveis e mililitros por copo. Para produtos individuais, informar unidades disponíveis e unidades por ficha (normalmente uma).

Exemplos sem margem de perda:

| Estoque | Porção | Capacidade de fichas |
| --- | --- | --- |
| 60 litros de chope | 500 ml | 120 copos |
| 60 litros de chope | 440 ml | 136 copos, com sobra de 160 ml |
| 100 garrafas de água | 1 garrafa | 100 fichas |

Calcular apenas porções completas, sempre arredondando para baixo. Registrar o tamanho da porção usada no evento. Proposta: permitir uma margem opcional de perda, explícita, para espuma, derramamento ou consumo operacional; não descontar uma margem sem informar a organização.

Se dois tamanhos de copo consumirem o mesmo barril, devem compartilhar o estoque em ml. Não cadastrar a capacidade total separadamente para cada tamanho, pois isso duplicaria o estoque vendável. Essa extensão deve ser tratada explicitamente caso o evento use múltiplas porções da mesma bebida.

## Regra de venda e retirada

Disponível para novas fichas = capacidade cadastrada + reposições − perdas registradas − fichas vendidas − cortesias emitidas − reservas de pagamento ativas.

1. Ao gerar o Pix, reservar a quantidade pelo prazo de pagamento. O projeto atualmente usa dez minutos.
2. Ao confirmar o pagamento, converter a reserva em venda, sem descontar a quantidade duas vezes.
3. Ao expirar ou cancelar uma reserva sem pagamento, liberar a quantidade. Confirmações tardias de pagamento precisam respeitar o tratamento de exceção, sem emitir fichas além do estoque.
4. Cortesias também comprometem o estoque. Consumo fora do sistema e perdas precisam ser registrados.
5. Ao retirar uma bebida, marcar a ficha como utilizada. Essa retirada reduz o físico esperado, mas não reduz novamente o disponível para venda.
6. Com saldo insuficiente para uma porção, bloquear a venda no servidor, inclusive em compras simultâneas e em celulares com o cardápio desatualizado. Atualizar o item no cardápio para indisponível.
7. Separar falta temporária por reservas de esgotamento por fichas emitidas. Reservas expiradas podem liberar venda novamente. Reposição registrada também pode liberar venda; suspensão manual deve continuar sendo respeitada.

Exemplo: 120 fichas emitidas e 80 copos retirados deixam zero disponível para novas vendas e 40 copos esperados para honrar as fichas restantes. O bloqueio precisa acontecer mesmo com líquido ainda no barril.

## Gestão no celular

Proposta de tela principal: lista de cartões por bebida, com nome, saldo para venda em destaque, fichas emitidas, reservas e retiradas. Mostrar litros equivalentes quando aplicável. Estados visíveis: disponível, acabando, temporariamente reservado, esgotado e suspenso.

Ações diretas: cadastrar estoque e porção, adicionar reposição, registrar perda e suspender venda. Ajustes devem conservar motivo e histórico. Evitar depender de tabelas largas para a operação no celular.

## Alertas e responsáveis

Requisito: avisar o responsável quando não houver estoque para continuar vendendo. Proposta complementar: aviso antecipado com limite configurável por item, por exemplo quando restarem dez copos.

Mensagem sugerida: "Chope esgotado para novas vendas. 120 de 120 copos comprometidos por fichas. Venda bloqueada automaticamente."

Proposta de entrega:

- Aviso persistente na gestão, com indicação de horário e botão "Ciente".
- Notificação push para os celulares cadastrados dos responsáveis, inclusive fora da tela da gestão quando o aparelho e navegador permitirem.
- Som na gestão quando permitido pelo aparelho; não depender exclusivamente de som, vibração ou da página permanecer aberta.
- Segundo responsável e escalonamento se ninguém confirmar ciência. Ligação ou outro canal externo são opções de escalonamento; fornecedor, custo, canal e prazo ainda não foram definidos.

O bloqueio de venda deve funcionar independentemente da entrega do aviso. Confirmar ciência não reabre a venda. Deduplicar alertas por ocorrência e registrar tentativas, falhas e confirmação, sem tratar envio como prova de leitura. Reposição deve permitir uma nova ocorrência futura.

Push depende de permissão, HTTPS e integração com service worker. Validar a entrega nos celulares reais usados no evento, inclusive com tela bloqueada. Referências: https://developer.mozilla.org/en-US/docs/Web/API/Push_API e https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API.

## Situação verificada antes da implementação

- `inventory` trabalha atualmente com quantidades inteiras por produto. Há contadores de reserva, venda, cortesia e retirada, além de restrição de saldo não negativo.
- A criação de pedidos reserva estoque em um lote de operações no banco antes de gerar o pagamento.
- O cardápio já mostra "Esgotado" quando o saldo retornado é zero.
- A gestão permite cadastrar estoque inicial em unidades, ajustar quantidades e suspender produtos. A atualização do painel usa intervalo de dez segundos enquanto a página está ativa.
- Não foram encontrados cadastro de volume/porção, serviço de push ou fluxo de alertas de estoque com responsáveis e confirmação.

Essa inspeção não substitui teste de concorrência e validação de notificações em aparelhos reais.

## Critérios de conclusão da implementação

- Cadastrar 60 litros com copo de 500 ml deve resultar em 120 fichas possíveis; com 440 ml, 136.
- Com apenas um copo disponível, duas compras simultâneas não podem comprometer dois copos.
- Venda, cortesia e reserva devem consumir a mesma capacidade; retirada não pode descontar duas vezes.
- Expiração libera reserva, reposição libera saldo e suspensão manual permanece respeitada.
- Saldo zero bloqueia nova compra no servidor sem depender do painel ou do alerta.
- Gestão deve ser utilizável em celular sem tabela larga para as ações principais.
- Alerta de esgotamento deve chegar aos aparelhos cadastrados em ensaio real; falha no canal deve permanecer visível e admitir nova tentativa.
- Confirmar ciência deve registrar quem recebeu o aviso e manter a venda bloqueada até haver saldo ou ajuste válido.

## Implementação local em 28/09/2026

- Cadastro e configuração inicial em unidades, litros ou ml; tamanho do copo e capacidade calculada pelo servidor.
- Reposição e perda em volume, conservando sobras de ml que ainda não completam um copo.
- Configuração inicial protegida contra movimentações simultâneas; porção bloqueada após o estoque começar a ser usado.
- Cartões de estoque adaptados ao celular, com saldo, emissão de fichas, reservas, retiradas, reposição, perda e suspensão.
- Cardápio atualizado a cada 15 segundos enquanto visível; quantidades do carrinho revisadas com aviso ao comprador quando o saldo mudar. A verificação no servidor continua sendo a autoridade para aceitar pedidos.
- Ocorrências persistentes de estoque baixo, saldo reservado e esgotamento geradas por triggers, no mesmo lote das mudanças de estoque. Deduplicação por transição de estado, saldo atualizado e encerramento após mudança de estado.
- Avisos acessíveis aos administradores, botão Ciente e histórico com responsável e horário. Som opcional enquanto a gestão estiver aberta.
- Web Push com VAPID, service worker, inscrição dos celulares administrativos, envio em segundo plano, até três tentativas com intervalo mínimo de dois minutos e interrupção após ciência ou encerramento da ocorrência.
- Aceite do serviço de push, recebimento informado pelo navegador e ciência humana são estados distintos. Uma sessão expirada ou revogada não recebe novos envios.
- Migrations locais aplicadas e cópia de segurança do D1 anterior às mudanças preservada em `output/stock-backup`.
- Prévia em moldura de celular em `/celular.html`, usando o app local real em iframe. Gestão direta em `/equipe?view=stock`.

Validação: build concluído e 23 testes automatizados aprovados, incluindo capacidade, sobras, perdas, concorrência na última porção, reservas, cortesias, deduplicação, ciência, criptografia do push, recebimento e sessões revogadas. Interface conferida em Chrome com emulação de iPhone a 390 px e toque, sem rolagem horizontal. No ensaio local, o item "Chope teste local" emitiu 120 fichas de cortesia e esgotou; nenhuma cobrança Pix foi gerada. Uma tentativa adicional de compra retornou HTTP 409 / OUT_OF_STOCK. O serviço de push aceitou o envio com HTTP 201 e o navegador confirmou recebimento pelo service worker. O botão Ciente registrou confirmação, mantendo o saldo para venda em zero. Isso não comprova recebimento em celular físico. Captura da prévia: `output/playwright/celular-gestao-final.png`.

Limites atuais: ainda não foi validado em aparelho físico com tela bloqueada, nem publicado em HTTPS. Ligação automática não está integrada. Estoque compartilhado por diferentes tamanhos de copo e margem percentual de perda são extensões futuras; cada produto tem estoque próprio, com perdas registradas explicitamente.
