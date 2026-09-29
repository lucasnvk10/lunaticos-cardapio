# Modelo de Excel para eventos

Proposta para alinhar com Lucas e Bruno. Este documento define a estrutura e as decisões pendentes; ainda não é o arquivo Excel aprovado.

## O que precisamos responder

Quanto comprar por bebida? Em qual horário reforçar o bar? Qual foi a receita, o lucro e o custo das cortesias? Quais produtos concentraram o resultado? O que deixou de ser vendido por falta de estoque? Quanto dinheiro realmente entrou na conta?

## Abas e granularidade

| Aba | Uma linha representa | Campos principais | Origem |
| --- | --- | --- | --- |
| Eventos | Um evento | ID, nome, data, local, duração, capacidade, público previsto, público real, clima, perfil do público | Organização; público real vem de controle de entrada |
| Produtos | Uma apresentação de bebida | ID, bebida, unidade de estoque, ml por copo, fornecedor, custo, preço, margem | Cadastro + compras |
| Composição de combos | Um componente do combo | ID do combo, ID do componente, quantidade por combo, ml consumidos, vigência | Definição com Bruno |
| Pedidos | Um pedido, sem duplicar pelos itens | ID, evento, data de criação e pagamento, status, tipo, valor bruto, provedor | Sistema |
| Itens dos pedidos | Um produto em um pedido | Pedido, evento, produto, quantidade, preço e valor total | Sistema |
| Fichas | Uma ficha | ID, pedido, bebida, emissão, status, retirada, leitor | Sistema |
| Estoque | Um movimento de um produto | Evento, produto, instante, tipo, quantidade física em ml/unidades, motivo, referência | Sistema + contagem física |
| Pagamentos | Um movimento financeiro | Pedido, cobrança, status, bruto, taxa, estorno, líquido, data de repasse, referência do extrato, documento fiscal | Gateway + extrato + sistema fiscal |
| Custos | Um custo do evento | Evento, categoria, fornecedor, valor, fixo/variável, documento | Organização |
| Acessos | Um agregado por evento/período | Evento, data, navegadores únicos, início da medição | Sistema; não equivale a pessoas presentes |
| Indicadores | Um evento/produto/período | Métricas calculadas e cobertura dos dados | Fórmulas/Power Query |
| Previsão | Um cenário por evento/produto | Base histórica, público previsto, consumo, margem de segurança, perdas, volume e compra | Fórmulas + decisões da organização |

IDs são as chaves de relacionamento. Dinheiro vem em centavos e só vira reais na apresentação. Não juntar Pedidos e Itens para somar faturamento: o total do pedido se repetiria por item. Importações devem substituir/atualizar por ID, sem duplicar registros a cada exportação.

O modelo analítico não precisa de CPF ou nomes de clientes. As exportações administrativas atuais podem conter dados pessoais; limitar acesso e remover essas colunas antes de compartilhar a base com terceiros.

## Definições dos indicadores

| Indicador | Cálculo | Cuidado |
| --- | --- | --- |
| Receita bruta | Soma de pedidos PAYMENT confirmados PAID | Cortesia não é receita; separar simulação |
| Ticket médio por pedido | Receita bruta / quantidade de pedidos pagos | Não dividir por quantidade de itens nem por público |
| Gasto por participante | Receita bruta / público real | Só existe com contagem de entrada confiável |
| Unidades vendidas | Itens de pedidos pagos, sem cortesias | Comprometem estoque antes da retirada |
| Consumo retirado | Fichas USED, separadas por pagamento/cortesia | Ficha comprada não significa bebida já entregue |
| Bebida mais vendida | Ranking de unidades pagas | Separar ranking de volume em litros e ranking de receita |
| Pareto de receita | Produtos por receita decrescente; participação e acumulado | Incluir o produto que cruza 80%; não presumir que serão exatamente 20% dos produtos |
| Margem de contribuição | Receita - taxas - custo dos itens - outros custos variáveis | Não é lucro enquanto custos fixos não forem abatidos |
| Resultado do evento | Receita líquida - custos variáveis - custos fixos | Estornos e cortesias precisam de tratamento explícito |
| Ruptura | Hora inicial/final sem disponibilidade; demanda recusada se medida | Venda observada com ruptura subestima demanda |
| Conversão do cardápio | Compradores que podem ser ligados a um acesso / acessos elegíveis | Ainda não calculada: sem vínculo confiável entre acesso e comprador |
| Acessos únicos | IDs anônimos de navegador por evento | Vários aparelhos por pessoa; apagar dados locais cria novo ID; histórico anterior não existe |
| Diferença de estoque | Contagem física final - saldo físico previsto | Registrar perdas, vazamentos, espuma e ajustes |

## Previsão: cenários, não promessa

1. Escolher eventos comparáveis por perfil, duração, local e preço. Indicar a cobertura e a qualidade dos dados.
2. Calcular consumo por participante usando público real e unidades retiradas, com cortesias identificadas. Se usar unidades vendidas, declarar a mudança de definição.
3. Para cada bebida: demanda-base = público previsto × consumo médio por participante.
4. Criar cenários conservador, base e alto. Ajustes por duração, clima e perfil precisam de valor explícito e justificativa, sem coeficientes inventados.
5. Compra sugerida = demanda ajustada × porção × (1 + margem de segurança) / (1 - fração de perda). Arredondar para embalagens completas. Definir se a margem já inclui perdas para evitar contá-las duas vezes.
6. Comparar previsão e realidade após o evento: erro por produto, sobra, ruptura e custo da sobra. Revisar as premissas.

Não usar apenas um evento com estoque esgotado como limite de demanda. É preciso registrar o período de ruptura e, se possível, pedidos recusados/interesse não atendido. O aplicativo atual não mede essa demanda perdida.

## Decisões para a conversa com Bruno

- “Combo de Chevette” será várias fichas de um mesmo produto ou uma receita com componentes? O app atual mostra os itens e fichas do pedido; ainda não tem composição de combos que baixa vários insumos.
- O estoque será contabilizado por copo vendido, volume físico ou ingredientes? Qual perda normal de cada bebida?
- Como vamos medir público real e registrar horário de entrada?
- Custos devem seguir custo médio, lote ou preço da última compra? Haverá devolução de barril/garrafas e aproveitamento de sobras?
- Quais taxas e prazos do PagBank devem ser conciliados? Como tratar pagamento tardio, estorno e devolução?
- Quais eventos entram no histórico comparável? Que fatores justificam cenários diferentes?
- Qual CNPJ/UF e sistema fiscal emitirá os documentos? Qual contador valida o fluxo? Quais contratos, autorizações e documentos do evento precisam de vínculo?

## O que está implementado nesta versão

Consulta por nome/telefone/número do pedido, equipe identificada na leitura, ticket médio, ranking de unidades, Pareto de receita, vendas por hora e novos acessos anônimos ao cardápio. O financeiro separa pagamentos PagBank confirmados de testes/outros provedores. Permite vincular links de documentos fiscais e jurídicos existentes, sem emitir nem verificar autenticidade fiscal.

Os relatórios existentes exportam vendas, fichas e saldo de estoque em CSV. O Excel completo e as importações específicas para cada aba ficam para a definição com Bruno. Não há cálculo de lucro, taxas, público real ou previsão automática sem essas fontes.
