# Gestão de pedidos, equipe e resultados

Validação local em 28/09/2026. Nenhuma publicação em produção foi executada.

- Consulta por nome, telefone com DDD ou número do pedido, sem busca nem exposição de CPF nessa consulta. Mostra status, itens, unidades retiradas e fichas disponíveis. Paginação de 25 pedidos. Telefone opcional no checkout, normalizado e validado no servidor. Pedidos antigos sem telefone continuam consultáveis por nome/número do pedido.
- Link de leitura gerado sem nome antecipado, válido por 24 horas, com limite de 50 entradas identificadas. O nome identifica o leitor; a autorização vem do link privado. Cada entrada cria um operador EVENTOS, que não recebe acesso administrativo. Links antigos de ativação individual continuam compatíveis.
- Equipe lista operadores, função, data de cadastro, acessos válidos e quantidade de fichas validadas. Não é formulário para conceder novos acessos administrativos.
- Análises: ticket médio por pedido pago, unidades pagas/cortesias, bebida mais vendida, Pareto de receita com curva acumulada e vendas por hora de confirmação. Horário de Brasília. Faturamento não se repete pelos itens. Corrigido o mapeamento de campos das tabelas e CSV do relatório.
- Acessos: ID aleatório guardado no navegador e hash por evento no banco. Sem IP, nome ou impressão digital de aparelho. Conta navegadores, não público presente; dados anteriores à implantação não existem. Limpeza do armazenamento e vários aparelhos podem mudar a contagem. Não exige identificação para abrir o cardápio.
- Financeiro: lista pedidos de pagamento de todos os status, total PagBank confirmado e total de testes/outros provedores separados. Comprovante imprimível do pedido pago, explicitamente não fiscal. Links de documentos fiscais existentes vinculados a pedido pago e documentos jurídicos do evento. O app não emite NFC-e nem verifica autenticidade fiscal, não calcula repasses líquidos e não substitui conciliação/validação contábil.
- A estrutura do Excel e as definições para previsão estão em `Modelo de Excel para eventos.md`; o arquivo Excel e as premissas finais ficam para alinhar com Bruno.

## Verificação

Build e TypeScript aprovados. 28 testes passaram. Testes de SQLite verificam transação dos convites, limite, expiração e revogação; consulta limitada ao evento, escape de curingas, exclusão de CPF/segredos; persistência do telefone; relatório e Pareto.

No Chrome, validado o fluxo de gerar link sem nome, entrar como “Leitor teste local”, registrar na equipe e bloquear APIs administrativas com HTTP 403. Consulta por Lucas retornou quatro pedidos locais com itens. Pedidos, equipe, pagamentos e resultados conferidos em largura de 390 px sem overflow horizontal da página. Pareto visual validado com dados explicitamente “TESTE VISUAL” interceptados apenas numa sessão separada; esses dados não foram gravados no banco. Foi registrado um acesso real do navegador de validação.

Prévia aberta em `http://localhost:8787/celular.html`, mostrando o aplicativo local real dentro de uma moldura de celular. Não é teste em aparelho físico. O servidor local precisa ficar em execução. Após novo build, reiniciar `wrangler dev` para atualizar o manifesto de assets.

Migration local 0013 aplicada. Exportação de segurança em `output/stock-backup/before-management.sql`, fora dos assets públicos. Permanecem os pedidos e leitores de teste identificados no ambiente local; não foram criados pagamentos reais ou documentos fiscais fictícios.
