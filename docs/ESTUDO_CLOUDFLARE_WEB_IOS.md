# Estudo Cloudflare para MinattoFlix: web e iOS

Data: 20/10/2026. “Sparkflare” foi interpretado como Cloudflare pelo contexto de Workers. Estudo baseado no código local e na documentação oficial consultada nesta data. Não houve consulta a faturamento, métricas de produção ou configuração da conta; recursos declarados não comprovam funcionamento em produção. Nenhum serviço foi contratado ou implantado.

## Decisão recomendada

Manter Workers Paid para a API compartilhada, preservar Neon como banco e priorizar três frentes: reprodução previsível no iPhone, proteção das operações da API e processamento de catálogo com filas. Aproveitar os serviços já configurados antes de ampliar a infraestrutura. Avaliar Stream com um piloto pequeno e comparar com HLS preparado previamente em R2.

## 1. O que o projeto já tem

| Recurso | Evidência local | Avaliação |
| --- | --- | --- |
| Workers + Static Assets | `wrangler.jsonc`, `src/worker/index.ts` | API Hono e interface React/Vite já compartilham implantação. |
| iOS Capacitor | `capacitor.config.ts`, `ios/App`, README | Interface empacotada usa API HTTPS. Cloudflare beneficia o backend; não compila nem assina o app. O usuário informa testes atuais no TestFlight; o README ainda descreve etapa anterior. |
| KV | Binding `MINATTO_KV`; serviços Google Drive/OneDrive | Cache de URLs e tokens já implementado. |
| R2 | Binding `MEDIA_BUCKET`; rotas de streaming e legendas | Há armazenamento de legendas e cache inicial de mídia. Não equivale a armazenar e entregar todo o catálogo pelo R2. |
| Workers AI | Binding `AI`; metadados e legendas | Há chamadas reais no código. É necessário medir qualidade e consumo. |
| Durable Objects | `WatchPartyRoom`, rotas watch-party | Watch Party e controle remoto implementados; estado da sala fica em memória e sockets usam `accept()`. |
| Cron | `*/5 * * * *` | Scanner e aquecimento de mídia a cada cinco minutos. São 288 disparos/dia; o trabalho de cada disparo determina custo e carga. |
| Hyperdrive | Binding declarado | `getDb()` usa `neon(DATABASE_URL)` diretamente. O binding não participa desse caminho. |
| Observabilidade | Logs estruturados; amostragem 0,1 | Base existente, sem comprovação de indicadores de experiência do player. |

Achados que mudam a prioridade:

- `/api/cloudflare/status` testa presença dos bindings com `Boolean(...)`; não comprova conectividade. A indicação de região é fixa, não uma medição.
- O health check chama o banco via Neon, embora o comentário mencione Hyperdrive. Bindings opcionais ausentes podem não impedir resposta saudável.
- Nas rotas inspecionadas de perfis, fontes e Watch Party não aparece autorização de usuário; o middleware global inspecionado também não a aplica. O webhook de downloads possui verificação própria. Validar eventual proteção externa antes de concluir exposição em produção.
- CORS `*` não autentica usuários nem impede chamadas diretas à API.
- O cache HLS em memória do Worker não garante que manifesto e segmentos atendidos por instâncias diferentes encontrem o mesmo estado. Auditar esse caminho antes de ampliar o uso.

## 2. Gratuito e pago

Workers Paid, plano do domínio e produtos como Stream/R2 têm faturamentos e franquias distintos. Pagar Workers não libera toda a plataforma. As franquias são compartilhadas no escopo de faturamento indicado pelo produto, não renovadas para cada Worker. Não considerar um Worker de homologação na mesma conta paga como franquia Free independente.

| Produto | Gratuito/franquia | Pago e implicação |
| --- | --- | --- |
| Workers | Free: 100 mil requisições/dia; 10 ms CPU por invocação | Mínimo US$ 5/mês por conta; 10 milhões de requisições e 30 milhões de ms CPU/mês incluídos. Excedentes: US$ 0,30/milhão de requisições e US$ 0,02/milhão de ms CPU. |
| Static Assets | Requisições a assets estáticos gratuitas e ilimitadas | Invocar código dinâmico pode gerar consumo Workers; conferir roteamento. |
| KV | Free: 100 mil leituras/dia, mil escritas/dia, 1 GB | Paid amplia franquias; escritas frequentes merecem controle. Usar para cache, não como fonte de verdade de progresso simultâneo. |
| R2 Standard | 10 GB-mês; 1 milhão de operações A e 10 milhões B/mês | US$ 0,015/GB-mês; operações A US$ 4,50/milhão e B US$ 0,36/milhão após franquias. Egress direto do R2 gratuito; outros serviços continuam cobrando seu consumo. |
| Queues | 10 mil operações/dia; retenção de 24h | Paid: 1 milhão de operações/mês incluído, depois US$ 0,40/milhão; retenção padrão 4 dias, configurável até 14. Uma entrega típica usa três operações; retentativas ampliam consumo. |
| Stream | Não presumir franquia de produção incluída no Workers | US$ 5/mês por bloco de mil minutos armazenados; US$ 1 por mil minutos entregues. |

Fontes: [Workers e KV](https://developers.cloudflare.com/workers/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [Stream](https://developers.cloudflare.com/stream/pricing/). Valores em USD, sem câmbio ou impostos; sujeitos a revisão.

## 3. Recursos aplicáveis, em ordem de retorno

| Prioridade | Recurso | Aplicação web/iOS | Próxima decisão |
| --- | --- | --- | --- |
| P0 | Workers + autenticação + limites | Identidade compartilhada, autorização por perfil, proteção de scanner, fontes e downloads | Definir sessões/tokens; validar autorização no servidor em cada operação. |
| P0 | R2 + pipeline HLS | Entregar segmentos previamente preparados, sem depender de memória de uma instância | Piloto com MP4/HLS, AAC e legenda WebVTT; validar Range, seek e troca de faixas. |
| P0 | Logs e métricas do player | Diagnosticar travamento, início lento e falha por versão do TestFlight | Registrar versão, sistema, codec, tempo até primeiro quadro, buffering e código de erro, sem tokens/URLs privadas. |
| P1 | Queues | Separar scanner, inspeção de arquivos, capas e legendas | Uma mensagem por tarefa; chave idempotente, limite de concorrência, retentativas e fila de falhas. |
| P1 | Workflows | Coordenar descoberta → análise → preparação → publicação | Estado durável por ingestão; processamento pesado executado por serviço apropriado. |
| P1 | Durable Objects | Melhorar salas e controle remoto | Persistir estado essencial, autenticar participantes e avaliar WebSocket Hibernation. |
| P1 | Ambientes e versões da API | Isolar testes do app e preservar compatibilidade com builds instaladas | Recursos separados para homologação; migrações aditivas e configuração por versão. |
| P2 | Hyperdrive | Possível redução de latência no acesso PostgreSQL | Comparar Neon HTTP atual com driver compatível via Hyperdrive; medir p50/p95 antes de migrar. |
| P2 | Images | Capas menores e variantes para celular | Medir peso das capas e usar dimensões corretas; validar autorização/cache da origem. |
| P2 | Workers AI + Vectorize/AI Gateway | Busca por descrição, enriquecimento e recomendações | Começar com busca atual como referência; impor orçamento e validar respostas. |
| P2 | WAF, Turnstile, Access | Proteção adicional e acesso administrativo | Conferir plano do domínio e cobertura da rota. Turnstile em WebView exige integração própria e validação no servidor. |
| P2 | Analytics Engine | Eventos de reprodução consultáveis | Adotar quando logs simples não bastarem; definir retenção e minimização dos dados. |

Referências: [Workflows](https://developers.cloudflare.com/workflows/), [WebSockets e hibernação](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [drivers Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/), [Images](https://developers.cloudflare.com/images/pricing/), [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Turnstile móvel](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/), [WAF](https://developers.cloudflare.com/waf/), [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/).

## 4. Reprodução: Stream ou R2?

| Critério | Cloudflare Stream | HLS preparado + R2 |
| --- | --- | --- |
| Operação | Serviço gerenciado de vídeo; entrega HLS/DASH | Precisamos preparar, versionar e manter arquivos/manifestos |
| Custo dominante | Minutos armazenados e entregues | GB armazenados, operações e processamento de preparação |
| Player | Pode usar player próprio | Player próprio e integração nativa sob nossa responsabilidade |
| Faixas e formatos | Validar suporte concreto de ingestão, áudio, legendas e qualidade no piloto | Mais controle; também maior trabalho para sincronizar e empacotar faixas |
| Escolha | Conveniente se reduzir manutenção justificar o consumo | Atrativo para acervo e requisitos específicos de faixas |

Stream fornece [manifests para player próprio](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/). Isso não comprova preservação de todos os recursos de MKV, Dolby, 4K ou dual áudio do catálogo. Transmuxar muda o contêiner; transcodificar muda o codec. Melhorar a infraestrutura não acrescenta codecs ao WebView do iOS.

Não recomendar transcodificação longa de filmes dentro de uma requisição Workers. Avaliar processamento externo ou [Containers](https://developers.cloudflare.com/containers/) em piloto, medindo recursos, duração, retomada e custo. A fila transporta referências aos arquivos, não os vídeos.

## 5. Plano para web e TestFlight

1. **Inventário e medição:** confirmar recursos/plano na conta, coletar sete dias representativos de uso e corrigir indicadores de status para diferenciar configurado, testado e falho.
2. **API e segurança:** autenticar usuários e administradores, limitar tarefas caras, proteger reprodução privada e preservar contratos das versões instaladas.
3. **Piloto de vídeo:** selecionar 5–10 arquivos representativos: H.264/AAC, HEVC, MKV com AC3/EAC3, dual áudio, legenda e filme longo. Comparar fluxo atual, HLS/R2 e Stream.
4. **Validação real:** Safari, navegador desktop e build TestFlight; Wi-Fi/rede móvel; seek, retomada, troca de áudio/legenda, bloqueio de tela e reconexão. Definir metas após medir a situação atual.
5. **Filas e salas:** introduzir Queues/Workflows; provar que retentativa não duplica catálogo. Validar reconexão e recuperação do estado da Watch Party após reinício.
6. **Expansão:** otimizar imagens, testar Hyperdrive e depois experimentar IA de busca.

Cloudflare pode compartilhar backend entre web/iOS. AirPlay, Picture in Picture, downloads offline e notificações exigem implementação e validação no app; não são habilitados pela contratação de Workers. TestFlight, assinatura e distribuição permanecem no fluxo Apple já utilizado.

## 6. Exemplos de orçamento

Exemplos calculados, não previsão de fatura:

- **API:** dentro das franquias de requisições e CPU do Paid, componente Workers a partir de US$ 5/mês. Somar banco, armazenamento, IA, filas, salas e demais produtos conforme consumo.
- **R2:** 1.000 GB-mês em Standard: aproximadamente `(1.000 − 10) × 0,015 = US$ 14,85/mês` de armazenamento. Acrescentar operações e preparação; cobrança considera unidades/arredondamentos do produto.
- **Stream:** 100 filmes de 120 minutos ocupam 12 mil minutos: US$ 60/mês de capacidade. Mil sessões completas desses filmes entregam 120 mil minutos: US$ 120. Total ilustrativo: US$ 180, além da API e outros componentes. Pré-carregamento e buffering também podem contar na entrega.

Medir requisições por sessão, GB do acervo, leituras/escritas KV, operações R2, minutos entregues, CPU e consumo de IA. Alertas de gasto não são necessariamente bloqueios; implementar limites de CPU e controles próprios para tarefas caras.

## 7. O que adiar

- **D1:** possível banco SQLite gerenciado; não há benefício comprovado em migrar o Neon agora.
- **Pages:** a interface já usa Workers Static Assets; não há necessidade demonstrada de migrar hospedagem.
- **Containers:** avaliar só se precisarmos controlar processamento de mídia e o piloto demonstrar viabilidade.
- **Tunnel/Access:** úteis se houver serviço privado de ingestão ou painel administrativo; não são requisito para o player público.
- **Realtime de áudio/vídeo:** Watch Party sincroniza reprodução, não transmite videoconferência; manter Durable Objects para esse caso.
- **Pipelines/data lake, Workers for Platforms e rede corporativa:** sem necessidade demonstrada neste projeto.

O ganho imediato esperado vem de melhorar reprodução, autorização e retomada de tarefas. Busca semântica e serviços adicionais entram depois de medir esses fundamentos.
