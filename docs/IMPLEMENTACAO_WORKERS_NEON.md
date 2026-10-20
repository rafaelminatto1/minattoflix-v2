# Implementação com Workers e Neon existentes

Atualizado em 20/10/2026. Esta implementação atende à restrição de não contratar serviços adicionais. Isso não é um teto de faturamento: consumo excedente de Workers/Neon e armazenamento previamente contratado continuam sujeitos aos planos das contas.

## Entregue

- `COST_MODE=restricted` por padrão, inclusive se a variável estiver ausente. O Worker remove acesso a bindings de R2, KV, IA, Hyperdrive, Durable Objects e token de execução GitHub nesse modo.
- Configuração sem bindings adicionais. Build e deploy verificam a política; uma alteração que reative esses bindings interrompe o build.
- Limite de CPU de 10 segundos por execução. Logs persistidos na Cloudflare desativados. Desenvolvimento não usa bindings remotos.
- API protegida por sessão assinada de 24 horas, com código de acesso doméstico e código administrativo separados. Todos os perfis pertencem ao mesmo grupo doméstico; não é um sistema de contas independentes por pessoa.
- Tela de acesso e saída compartilhada por web e bundle iOS; sessão acompanha requisições somente à API configurada. URLs de mídia recebem sessão para os players que não enviam cabeçalhos.
- Limitação de tentativas de entrada e de operações administrativas, armazenamento de hash de IP, limite de 64 KiB por solicitação (2 MiB para upload de legendas) e webhook obrigatório com segredo.
- Fila PostgreSQL com deduplicação de tarefas ativas, claim atômico, lease de 15 minutos, conclusão protegida pelo token da execução e até três tentativas. Falhas de fontes deixam o scanner elegível a retentativa.
- Cron a cada seis horas para tarefas pendentes e manutenção. A descoberta automática está desativada; solicitar sincronização agenda uma tarefa. O cron processa uma tarefa por disparo. A interface informa o agendamento, sem anunciar conclusão antecipada.
- Watch Party e controle remoto por HTTP/Neon, com estado persistente, eventos incrementais e atualização a cada cinco segundos. Polling pausa quando o app está oculto e aplica recuo após erros. Exige acesso doméstico; o código da sala não é um convite para usuários externos sem sessão.
- Métricas agregadas por dia/plataforma/evento, sem armazenar conteúdo de mídia, URLs privadas ou tokens. No máximo seis eventos por montagem de reprodução: início, até três esperas, erro e fim. Manutenção remove agregados antigos; o limite de três esperas serve a diagnóstico amostrado, não mede todos os travamentos.
- Painel operacional com métricas e tarefas reais. Status de bindings indica configuração, sem alegar conectividade nem região fixa. Liveness público não consulta o banco; diagnóstico profundo exige administrador.
- Service worker em JavaScript válido, limitado a assets públicos. API, mídia, Range e solicitações autenticadas não entram no cache. Remove somente caches antigos do próprio MinattoFlix.
- Cache inicial de vídeo limitado a 48 MiB, evitando guardar até centenas de MiB em um Worker de memória limitada.
- HLS dinâmico baseado em memória de uma instância desativado no modo restrito. O player usa arquivos originais/MP4 ou seu caminho WebCodecs; não promete novos codecs ao iPhone.
- Legendas existentes continuam no Neon; quando nenhuma legenda real é encontrada, o sistema não inventa diálogo ou trechos sincronizados.
- Ferramenta `prepare:local` usa FFmpeg no computador para gerar MP4 H.264/AAC, até 1080p, áudio estéreo por faixa e fast-start. Não sobrescreve o original. As faixas de áudio são preservadas como faixas AAC; legendas devem ser enviadas separadamente. Não preserva Dolby/HDR/4K como no original.

## Recursos mantidos desativados

Stream, Images, Vectorize, Workers AI, R2, KV, Durable Objects, Queues/Workflows gerenciados, Containers, transcodificação no GitHub e downloads executados externamente. As funções equivalentes possíveis usam Neon, processamento local ou o player existente. Recursos antigos não foram apagados; remover bindings não exclui objetos já armazenados nem cancela contratos anteriores.

Hyperdrive/D1 não foram usados para migrar o banco. Mantivemos o driver Neon HTTP existente. AirPlay, codecs nativos, notificações e assinatura/distribuição Apple não são ativados por essa infraestrutura.

## Operação local

```sh
npm ci
npm run setup:access
npm run typecheck
npm test
npm run build
npm run build:native
```

`setup:access` cria os três segredos em `.dev.vars`, preservando valores existentes. Consulte esse arquivo somente no computador. Ele é ignorado pelo Git e não deve ser incluído em clientes, screenshots ou mensagens. O código administrativo permite alterações; o código doméstico permite catálogo, progresso, lista e salas.

Preparar um arquivo sem processamento pago:

```sh
npm run prepare:local -- "D:/midia/original.mkv" "D:/midia/copia-iphone.mp4"
```

Requer FFmpeg instalado no PATH. A execução usa CPU, espaço e energia do computador. Envie a cópia à mesma pasta do título na fonte existente e agende a sincronização. Compatibilidade e cores precisam de validação com os arquivos reais, especialmente conteúdo HDR.

## Banco e retenção

A migração `migrations/001_reliability.sql` cria apenas seis tabelas operacionais e seus índices. Foi testada em PostgreSQL local/PGlite e aplicada em transação ao Neon já configurado, sem criar projeto, branch ou compute adicional. Não altera tabelas de catálogo/perfis/progresso.

O comando é idempotente:

```sh
npm run migrate:operations -- --apply
```

As tarefas têm processamento pelo menos uma vez: scanner e operações derivadas devem continuar idempotentes. Um scanner muito grande pode exigir particionamento adicional; três falhas encerram a tarefa para inspeção. Não há transcodificação de filmes na fila.

Manutenção a cada seis horas remove tarefas finalizadas com mais de sete dias, métricas fora da janela, salas inativas por mais de um dia, eventos com mais de uma hora e participantes sem heartbeat. Registros podem permanecer até o próximo disparo. Nenhum arquivo do catálogo é apagado pela manutenção operacional.

## Publicação coordenada

O código web/Worker e o bundle JavaScript iOS são preparados localmente. Compilação Swift, assinatura, IPA e validação no iPhone continuam exigindo Xcode/Codemagic e a conta Apple existentes.

Antes de publicar o Worker, cadastrar `ACCESS_CODE`, `ADMIN_CODE` e `SESSION_SECRET` como segredos de produção com Wrangler, preservando `DATABASE_URL` e demais segredos atuais. Nunca colocar esses valores em `wrangler.jsonc` ou variáveis do bundle iOS. Configurar domínio web adicional em `ALLOWED_ORIGINS` se o frontend estiver em origem diferente.

Publicar a nova build do app junto da mudança de acesso: builds antigas do TestFlight não têm login e receberão 401 na API protegida. Não foi introduzido desvio de autenticação para clientes antigos. Para trocar uma sessão em reprodução com mais de 24h, é necessário entrar novamente. Rotacionar `SESSION_SECRET` invalida todas as sessões.

Sem os três segredos, a API privada responde 503. Não publicar uma versão incompleta contando com acesso anônimo como fallback.

## Verificações

- Testes de assinatura, privilégios, CORS, webhook, tamanho de payload e bloqueio de serviços extras.
- Testes da fila e integração SQL real em PostgreSQL/PGlite: migração reaplicável, deduplicação, claim concorrente, retentativas, limite de tentativas, salas, cursores, métricas e retenção.
- Testes existentes de catálogo, áudio, canvas, fullscreen e API nativa.
- Build web e bundle nativo, além de verificação da política de custo.
- Validação visual com `tests/access-ui-validation.js` no Playwright: formulário móvel/desktop, erro, entrada, autorização e saída com dados simulados.
- Smoke test do runtime Workers local com o Neon existente: login real, sessão administrativa, bloqueio do acesso doméstico ao diagnóstico, consulta de saúde e bindings adicionais desativados. Credenciais não foram impressas.

Os testes de navegador usam respostas simuladas; não equivalem a reprodução em iPhone real. O build mantém avisos de tamanho de bibliotecas de mídia; isso não bloqueia compilação, mas merece otimização futura baseada em medição.
