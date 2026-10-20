# Revisão do MinattoFlix: catálogo, reprodução e experiência nativa

Data: 20/10/2026. Interpretação de “nativeflix”: experiência fluida de streaming no estilo Netflix, com integração adequada ao iOS. Não foi fornecida uma referência de outro produto chamado Nativeflix.

## Escopo e limites

Revisão estática da interface React, player, serviços de áudio, API Hono/Cloudflare, scanner Drive/OneDrive, configuração Capacitor/iOS e CI. Documentação consultada pelo MCP Rafalegollas/Context7: Capacitor, HLS.js e Mediabunny; documentação Apple e Cloudflare consultada diretamente.

Não houve acesso ao iPhone, reprodução real nesta revisão, teste visual ao vivo, auditoria da configuração de segurança implantada, teste de carga ou inspeção dos dados de produção. As constatações abaixo descrevem o código local; eventual proteção externa precisa ser verificada separadamente. Esta revisão não altera funcionalidades nem publica versões.

Validação da base: 41 testes automatizados passaram e TypeScript passou. O build nativo havia passado no trabalho anterior. Esses testes não demonstram sincronismo audiovisual nem usabilidade em dispositivo real.

## Decisão arquitetural recomendada

Manter React/Capacitor para catálogo e navegação. Priorizar conteúdo preparado em MP4 compatível ou HLS validado. Introduzir um adaptador de reprodução para permitir AVPlayer/AVKit no iOS, player web nas plataformas web e um caminho de compatibilidade explicitamente testado para arquivos especiais.

Migrar para AVPlayer não torna qualquer MKV/Dolby automaticamente compatível: o material deve ser empacotado/convertido para formatos e codecs aceitos. Avaliar outro motor nativo apenas se reproduzir os originais MKV sem preparação for requisito obrigatório; medir compatibilidade, tamanho, consumo e condições de distribuição antes da escolha.

Fluxo proposto de alimentação:

1. Conectar fonte e validar acesso.
2. Criar trabalho persistente com identificador, estado e relatório.
3. Descobrir todos os arquivos, percorrendo paginação e pastas.
4. Identificar título/ano/temporada/episódio; enviar correspondências ambíguas à revisão.
5. Inspecionar codecs, duração, resolução, idiomas e timestamps com ferramenta de mídia.
6. Reaproveitar material compatível; remultiplexar quando suficiente e transcodificar quando necessário, em executor próprio para mídia.
7. Gerar e validar playlists/segmentos, legendas e imagens. Publicar arquivos versionados em armazenamento persistente.
8. Liberar o título como disponível somente após validação; atualizar catálogo sem apagar itens por falha temporária de listagem.

States sugeridos: descoberto, identificando, inspecionando, preparando, validando, disponível, falha, indisponível. Interface de administração deve permitir tentar novamente, corrigir identificação e acompanhar erros por arquivo.

## P0 — corrigir antes de ampliar o uso

### 1. Autorização de API e separação entre usuário e administrador

Evidência: `src/worker/index.ts` monta as rotas sem middleware de autenticação. `storage.ts`, `scanner.ts`, `profiles.ts`, `downloads.ts` e `bootstrap.ts` permitem alterações/disparo de tarefas; bootstrap retorna todos os perfis e fontes. O webhook de downloads só exige segredo quando a variável existe.

Impacto: quem alcançar a API, na ausência de proteção externa, pode alterar perfis, histórico, fontes e trabalhos. CORS não substitui autorização.

Ação: sessões de usuário; associação entre conta e perfis; papéis de administrador; autorização de cada mídia/perfil; validação dos corpos; limites de chamadas e custo; webhook autenticado obrigatório, com idempotência e proteção contra repetição. Não embutir segredo administrativo no app. Restringir CORS às origens necessárias como medida complementar.

Aceite: chamadas anônimas administrativas recebem 401; usuário sem permissão recebe 403; trocar `profileId` não concede acesso; webhook sem configuração segura recusa atualização.

### 2. Evitar exclusão de catálogo por varredura incompleta

Evidência: `services/onedrive.ts` converte falhas de subpastas em `files: []`; o scanner em `routes/scanner.ts` apaga arquivos/faixas ausentes do conjunto descoberto, desde que algum arquivo tenha sido encontrado. A listagem Google pede `pageSize=200` sem percorrer `nextPageToken`. A listagem OneDrive lida com `children`/`value` sem percorrer continuação e ignora subpastas mais profundas nessa etapa.

Impacto: falha parcial ou paginação pode parecer remoção real e apagar referências válidas; uma fonte completamente vazia também não é reconciliada pelo mesmo caminho.

Ação: resultado explícito de completude por fonte/pasta, paginação, retomada, identificador de varredura, marcação `last_seen`, exclusão lógica com carência e confirmação em varredura completa posterior. Erro de rede nunca equivale a pasta vazia.

Aceite: simular erro em uma subpasta, centenas de itens e falha entre páginas preserva o catálogo anterior. Remoção real só é confirmada após listagem completa.

### 3. HLS precisa de preparação e armazenamento confiáveis

Evidência: `routes/stream.ts` usa `hlsHandlerCache`, um Map local, inclusive para servir segmentos; sua disponibilidade depende do mesmo processo/isolate. `services/hls-transmuxer.ts` recebe bytes no mux.js, declara combinações de codecs e resolução fixa no manifesto. O endpoint oferece AAC como alternativa sem demonstrar uma conversão de áudio correspondente.

Impacto: segmentos podem sumir entre requisições; trocar nomes de codecs na URL não converte arquivos nem cria qualidades adaptativas. Esse caminho não é uma solução geral de MKV para HLS.

Ação: gerar variantes reais fora da requisição de playback, com inspeção, timestamps consistentes e segmentos persistentes/versionados. Manifesto deve anunciar somente codecs, idiomas, resolução e bitrates produzidos. Usar Worker para autorização/entrega/orquestração, com execução de mídia adequada ao trabalho.

Aceite: qualquer instância atende o mesmo segmento; buscar no início/meio/final funciona; variantes anunciadas existem; playlist passa no validador Apple; conteúdo toca por uma sessão longa no iPhone.

## P1 — confiabilidade funcional

| Item | Evidência no código | Trabalho necessário e aceite |
| --- | --- | --- |
| Relógio e buffering audiovisual | `mkvAudioController.ts`: vídeo usa `performance.now()`, áudio agenda em `AudioContext.currentTime`; o contexto chamado MasterClock não unifica esses dois agendadores | Coordenar readiness das duas trilhas e relógio contínuo; interromper ambos imediatamente durante underrun. O bloqueio do primeiro quadro já adicionado é parcial: não prova sincronismo sustentado nem detecta uma espera de decodificação enquanto ela ocorre. Testar início, seek, velocidade, pausa, rede lenta e retomada |
| Máquina de estados do player | `NetflixPlayer.tsx` mistura vários booleans, seleção de fontes, áudio, HLS, canvas e UI; há efeitos duplicados de intro e wake lock | Extrair adaptadores e estados carregando/pronto/reproduzindo/pausado/buffering/falha/finalizado; garantir um único pipeline ativo e descarte de operações antigas |
| APIs no bundle iOS | `NetflixPlayer.tsx` usa `fetch('/api/metrics')` e `fetch('/api/media/next-episode/...')`; outras rotas já usam `apiUrl` | Centralizar URLs HTTP/WS e tratamento de erros. Testar que nenhuma requisição de backend vai para localhost no app |
| Séries e episódios | `App.tsx` monta item de episódio sem definir `episode_id`; progresso enviado usa `mediaItemId: item.id`; próximo episódio lê `episode_id` e navega via `window.location.href` | Identidade e progresso próprios por episódio, retomada correta, troca interna de episódio, cancelamento do countdown e suporte no canvas. Aceite: dois episódios preservam posições independentes e avançam sem recarregar o app |
| Espelho escolhido não chega ao play | `DetailModal.tsx` mantém `selectedFileId`, mas `onPlay` não recebe esse valor | Passar identificador de arquivo escolhido e preservar idiomas/progresso no failover. Aceite: escolher espelho B realmente inicia B |
| Ciclo de vida iOS | Existem listeners web de visibilidade e salvamento, mas não integração com App/Network do Capacitor nas dependências inspecionadas | Tratar interrupção, foreground/background, mudança de rota de áudio e rede; manter snapshot local de progresso e sincronizar com controle de versão. Testar bloqueio de tela, telefone, AirPods e encerramento pelo sistema |
| Alimentação persistente | Scanner executa loops de descoberta/enriquecimento e também é disparado no `waitUntil` do webhook; cron é a cada 5 minutos, comentário diz 15 | Criar jobs com progresso, etapas, tentativas, checkpoints, controle de concorrência e exclusão mútua. Jobs longos devem usar Queue/Workflow ou executor persistente; não depender da janela de execução pós-resposta |
| Identificação e veracidade do catálogo | `scanner.ts` usa título/slug como correspondência, ano de fallback 2025, episódios de 42 minutos e texto fixo “Dual Áudio 5.1” | Persistir ID de metadados confiável, tipo e ano; detectar remakes/duplicatas; distinguir dado inspecionado, inferido e desconhecido. Não anunciar áudio/HDR/resolução sem confirmação |
| Integrações de nuvem | OneDrive usa endpoints Badger/personal content; Google tem fallback por parsing de HTML | Preferir integrações documentadas e autorizadas para o caso de uso, com paginação, renovação de acesso, limites, backoff e diagnóstico. A dependência dos endpoints atuais exige validação específica; não assumir estabilidade de API pública |
| Observabilidade real | métricas usam URL relativa, sessão pode ser recriada por evento, `Math.round` perde precisão, `playback_stalled` representa apenas !paused; endpoint de qualidade retorna estrutura de exemplo | Persistir eventos agregados com sessão estável; medir clique ao primeiro quadro e ao áudio, duração de stalls, erro por fonte/codec/build e drift quando mensurável; instrumentar também canvas. Proteger ingestão e remover URLs sensíveis |

## P2 — UX/UI de uso diário

As observações desta seção vêm da estrutura e estilos locais. Exigem validação visual e testes de interação no iPhone antes de considerar o resultado aprovado.

1. **Navegação móvel:** reduzir seis ícones sem texto para 3–5 destinos com rótulos claros, por exemplo Início, Buscar, Séries, Minha lista e Perfil. 4K e coleções entram em filtros/linhas. Não apresentar Downloads como função offline até existir implementação local real.
2. **Separar administração:** mover nuvem, scanner, inspeção de MKV, enriquecimento de metadados e diagnósticos para área administrativa. A tela do filme concentra capa, título, sinopse, classificação, duração, disponibilidade, Reproduzir/Continuar e Minha lista.
3. **Player mais simples:** controles principais grandes; idiomas/legendas em painel dedicado; velocidade, ajuste de sincronismo e diagnóstico em opções avançadas. Textos de erro com ação específica e feedback discreto de reconexão.
4. **Preservar imagem:** `videoFitMode` começa em `cover` e `isCover` força preenchimento no fullscreen móvel. Começar com imagem completa (`contain`) e respeitar a escolha; ampliar deve ser uma ação consciente, sem cortar legendas/quadro silenciosamente.
5. **Acessibilidade:** alvos principais de ao menos 44×44 pontos equivalentes no contexto iOS; hoje `.touch-target-sm` define 36px e é muito usada. Ampliar rótulos essenciais (há textos de 9–11px), revisar contraste, VoiceOver, foco, seleção e estados de carregamento. Aproveitar safe areas, foco de diálogo e reduced motion já existentes.
6. **Abertura e créditos:** remover fallback universal de 88 segundos e inferência automática por silêncio de legendas como fonte definitiva. Intervalos verificados por episódio e armazenados por mídia; só mostrar botão quando existir marcador confiável. Eliminar variáveis globais de intro que podem vazar para outro título.
7. **Continuar assistindo:** ordenar por última reprodução; mostrar episódio e tempo restante; separar Retomar e Começar do início; remover histórico com desfazer. Conclusão precisa refletir contexto do episódio/créditos, não apenas porcentagem genérica.
8. **Busca:** tela dedicada com teclado/foco corretos, cancelamento, estado vazio e retorno preservado; evoluir busca/paginação para o servidor conforme o catálogo crescer. Usar metadados de gênero/franquia; regex de Batman/Constantine/Mario não representa uma coleção editorial confiável.
9. **Carregamento:** skeletons com tamanho reservado, imagem responsiva, placeholder em erro, ações desabilitadas durante transição e mensagem de indisponibilidade. Diferenciar preparando vídeo, problema na rede e arquivo incompatível.
10. **Orientação e sistema:** catálogo em retrato como padrão de uso, player com rotação validada, status bar/home indicator e teclado sem cobrir ações; voltar deve restaurar scroll e foco. Validar gestos do iOS em vez de depender somente de `screen.orientation.lock`.
11. **Preferências:** salvar áudio, legendas e acessibilidade por perfil. Não depender exclusivamente de `localStorage` global compartilhado por perfis.
12. **Perfis infantis:** filtro local por classificação já existe, mas regras de acesso devem ser aplicadas também no servidor e na navegação de perfis/administração.

## P2 — desempenho, manutenção e distribuição

- Bootstrap “summary” ainda consulta todo o catálogo, arquivos e faixas e retorna fontes/perfis; criar resposta compacta por contexto, carrosséis paginados e detalhes sob demanda. Definir metas com tamanho real de biblioteca.
- `App.tsx` importa NetflixPlayer estaticamente e também faz preload dinâmico: adotar lazy loading efetivo e carregar decodificadores pesados quando necessários. O build anterior gerou chunk de player de aproximadamente 1,98 MB antes de gzip; tamanho do arquivo não equivale a tempo de inicialização medido.
- Revisar deduplicação de requests: o primeiro consumidor recebe o Response original e consumidores posteriores clonam esse objeto, sujeito a corpo já consumido; sinais de cancelamento são compartilhados. Testar concorrência e cancelamento antes de reformular.
- Consolidar timeout, retry com backoff e cancelamento; só repetir mutações quando forem idempotentes. Corrigir prewarm que marca tentativa como concluída mesmo em HTTP de erro.
- Testar mudanças de fonte sem perder posição e sem duplicar decodificadores, contextos de áudio, timers ou listeners. Remover efeitos duplicados e dividir o componente player por responsabilidades.
- Adicionar testes de integração scanner/paginação/reconciliação, autorização e persistência de episódios; E2E web e matriz física iOS. Testes de renderização com mocks não validam codecs.
- Versionar mudanças de schema e revisar índices/chaves/transações conforme consultas reais; confirmar mecanismo de migração existente antes de adicionar outro.
- Revisar localização: Info.plist declara região `en` apesar da UI em português; revisar textos e acessibilidade do bundle.
- Validar conteúdo de privacidade e manifests exigidos pelas APIs/SDKs efetivamente usados, configuração de release e metadados do App Store Connect. Fazer essa conferência no archive final, sem presumir que ausência de arquivo no diretório do app implica falha dos frameworks.
- CI atual executa TypeScript, testes e bundle nativo; Codemagic prepara archive, com publicação desativada. Acrescentar validação de release e roteiro físico por build antes da distribuição. Não alterar publicação automaticamente como parte desta revisão.

## Ordem recomendada de implementação

| Etapa | Entrega | Condição para avançar |
| --- | --- | --- |
| 1 | Proteger API e tornar reconciliação não destrutiva | Testes de autorização e falhas parciais/paginação passam |
| 2 | Corrigir URLs nativas, escolha de espelho e identidade de episódio | Fluxos de filme e série funcionam no bundle sem chamadas locais de backend |
| 3 | Preparação de mídia persistente e adaptador de playback | Amostras representativas de HLS/MP4 validadas, seek e idiomas corretos |
| 4 | Integração iOS e sincronismo sustentado | Sessões longas, interrupções e Bluetooth passam em dispositivos físicos |
| 5 | Simplificar UX/UI e acessibilidade | Navegação e reprodução aprovadas por roteiro visual/VoiceOver |
| 6 | Escala, telemetria e release | Metas medidas, erros rastreáveis por build e checklist de distribuição cumprido |

Metas propostas para homologação, não medições atuais: primeiro quadro em até 3 s no p95 em rede de teste definida e mídia preparada; diferença audiovisual de até 100 ms em amostras de teste; retomada de progresso com erro de até 5 s; zero perda de catálogo em testes de listagem parcial; zero som isolado durante tela preta/buffering. Usar clipe com marcador visual/sonoro para medir sincronismo; leituras de relógio JavaScript não substituem medição da saída perceptível, especialmente em Bluetooth.

Matriz mínima: iPhone mais antigo suportado e recente; retrato/paisagem; Wi-Fi estável/lento, queda e troca de rede; MP4 H.264/AAC, HLS preparado, HEVC suportado e MKV de compatibilidade; áudio alternativo/Dolby conforme suporte declarado; legendas; retomada/seek; alto-falante/AirPods; bloqueio/interrupção/retorno; episódio seguinte; reprodução longa. iPad, Android/TV e web precisam de matrizes próprias caso continuem no escopo.

## Referências consultadas

- [Capacitor App: ciclo de vida](https://capacitorjs.com/docs/apis/app) e [Network](https://capacitorjs.com/docs/apis/network), via Rafalegollas/Context7.
- [HLS.js: suporte e seleção de implementação](https://github.com/video-dev/hls.js/blob/master/README.md), via Rafalegollas/Context7. Compatibilidade de codec depende da plataforma em execução.
- [Mediabunny: exemplo de player com relógio de áudio](https://github.com/vanilagy/mediabunny/blob/main/dev/player.html) e [media sinks](https://github.com/vanilagy/mediabunny/blob/main/docs/guide/media-sinks.md), via Rafalegollas/Context7. Exemplos atuais devem ser adaptados à versão instalada, não copiados sem conferir APIs.
- [Apple: especificação HLS](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html).
- [Apple: acessibilidade](https://developer.apple.com/design/human-interface-guidelines/accessibility) e [botões](https://developer.apple.com/design/human-interface-guidelines/buttons).
- [Cloudflare: Context e limites de waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/). A janela pós-resposta não substitui execução durável de jobs.
