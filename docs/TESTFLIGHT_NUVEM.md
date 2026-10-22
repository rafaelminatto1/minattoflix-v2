# TestFlight pela nuvem

O workflow manual `ios-testflight` em `codemagic.yaml` prepara a interface,
executa TypeScript e testes, compila o projeto Xcode com Swift Package Manager,
exporta o IPA assinado e envia para processamento no App Store Connect.
O envio para revisão beta externa e para a App Store fica desativado.
Depois do processamento, atribua o build ao grupo de testes internos no TestFlight.

## Identidade registrada

- App: MinattoFlix
- Apple ID: `6824745749`
- Bundle ID: `com.rafaelminatto.minattoflix`
- Team ID: `G7FDW933SF`
- SKU: `minattoflix-ios-001`
- Idioma principal: Português (Brasil)
- App Store Connect: https://appstoreconnect.apple.com/apps/6824745749

## Configuração necessária no Codemagic

1. Entre em https://codemagic.io e conecte somente o repositório
   `rafaelminatto1/minattoflix-v2`.
2. Em Team integrations > Developer Portal, configure a integração Apple
   com o nome exato `MinattoFlix Codemagic`, usando uma chave App Store Connect
   com o papel App Manager. A chave privada deve ficar somente no cofre do
   serviço, nunca no Git ou em mensagens.
3. Em Code signing identities, adicione um certificado Apple Distribution
   e um perfil App Store para o Bundle ID acima, com suas chaves privadas.
   O portal permite gerar os arquivos após configurar a integração Apple.
4. Envie `codemagic.yaml` e as alterações do aplicativo ao repositório.
5. Adicione o aplicativo no Codemagic, selecione a branch que contém a versão
   desejada e execute manualmente `ios-testflight`.
6. Confira o log de upload e aguarde o processamento na Apple. Responda às
   perguntas de exportação conforme os recursos reais do app e atribua o
   build ao seu grupo interno no TestFlight.

Não há gatilhos automáticos de build nesta configuração. Confira a franquia
e o preço exibidos na sua conta antes de iniciar máquinas cobradas.

## Validação local

`npm run ios:prepare`, `npm run typecheck` e os 39 testes passaram no Windows.
A compilação Swift, a assinatura e o upload passaram no Codemagic em
20/10/2026. Versão enviada: `1.0 (1)`, branch `codex/ios-testflight`, commit
`2549014cb6a190e49db7ba6822d83a83c12a7917`. O primeiro build usa o código
versionado nessa branch; alterações locais não commitadas não fazem parte dele.

Build: https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad6dc597550aed810905ca1

A Apple confirmou o upload sem erros. O grupo interno
`MinattoFlix - Teste pessoal` foi criado e a conta do titular foi adicionada.
O processamento Apple e a disponibilidade para instalação são etapas posteriores
ao upload e devem ser confirmados na página TestFlight.

Referências:
- https://docs.codemagic.io/yaml-quick-start/building-an-ionic-app/
- https://docs.codemagic.io/yaml-quick-start/building-a-native-ios-app/

## Atualização integrada de 20/10/2026

- Código do aplicativo: `c2c79ab80016ad346aff0fdc7d5276554b176f6e`, integrado em `main`.
- Produção publicada: https://minattoflix-v2.rafalegollas.workers.dev
- Versão Cloudflare: `3d4ed1ae-c4b7-445d-8aa6-ad02ceb4927c`.
- Login de usuário/admin e acesso ao Neon verificados em produção. Os códigos locais estão no arquivo ignorado `.env.minattoflix-access`; nunca versionar seu conteúdo.
- 68 testes, TypeScript, build web/nativo, compilação Swift, assinatura e upload passaram. A conversão FFmpeg com mídia sintética também passou no CI.
- Build `1.0 (3)` enviado e processado pela Apple: https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad7ae98454d2506f7ab8b11
- A chamada de atribuição do Codemagic falhou: a API Apple recusou adicionar o build ao grupo interno `MinattoFlix - Teste pessoal` (`Cannot add internal group to a build`). A verificação posterior na interface Apple confirmou que o grupo já recebe o build: `1.0 (3)` está **Em testes**, com um testador interno. A Apple registra a versão 1.0 (3) instalada no iPhone 15 do titular em 20/10/2026. Orientações de teste foram salvas no build.
- Removida essa atribuição incompatível do YAML para os próximos envios. Para o grupo interno, habilitar distribuição automática ou adicionar o build pela interface Apple.
- Workers + Neon permanece restrito: processamento GitHub, R2 e IA desativados. A preparação de vídeos é local. Sincronismo, interrupções e reprodução precisam de teste físico no iPhone.

## Reprodução direta e imersiva — 20/10/2026

- Build `1.0 (6)`, commit `da7f86e9e4e8793ad461b9b3d4e86f70c62eaf15`: https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad7ddba454d2506f7ab9b24
- Apple confirmou `1.0 (6)` **Em testes** no grupo `MinattoFlix - Teste pessoal`, com um testador interno. Roteiro salvo no campo “O que testar”. ID Apple do build: `72a2c3e0-dff8-4b2d-921d-45a71d6245ff`.
- Arquivos sem versão nativa compatível passam automaticamente ao player alternativo. Falhas de abertura nativa também tentam o alternativo; essa troca não converte codecs incompatíveis.
- No app iOS, o player alternativo tenta reprodução automática, com controles inicialmente ocultos. Safari mantém as restrições de gesto existentes.
- Durante o filme, o bridge oculta a barra de status e a restaura na saída. O player AVKit também oculta a barra de status; seus controles próprios aparecem ao tocar no vídeo e incluem pausa, busca, retorno, áudio e legendas.
- TypeScript, 69 testes, builds web/nativo, compilação Swift, assinatura e upload Apple concluídos. O build 5 não foi publicado: corrigida incompatibilidade de override do indicador inferior do Capacitor antes do build 6.
- Produção: versão Cloudflare `4ca02478-001d-4125-b24d-3c9021fd4d18`. Catálogo HTTP 200 sem código, com sessão pública viewer; funções administrativas seguem protegidas.
- Validação física pendente: início direto, controles por toque, relógio oculto, retorno ao catálogo e sincronismo em filmes MP4 e MKV.

## Interface móvel e controles por toque — 20/10/2026

- Build `1.0 (7)`, commit `d42a7e50e65949de572318d3ba245223bcb08a02`: https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad7eb92454d2506f7ab9ee3
- Confirmado **Em testes** no grupo interno `MinattoFlix - Teste pessoal`; roteiro salvo em “O que testar”. ID Apple: `a526f560-19e3-4f35-92ec-8e7aae160410`.
- Navegação móvel: Início, Buscar, Minha lista e Perfil. Categorias continuam disponíveis como filtros no cabeçalho. Busca com histórico local por perfil e limpeza; campo em 16px para evitar zoom involuntário do iPhone.
- Perfil concentra troca de perfil e acesso administrativo. Ferramentas administrativas exigem sessão admin; removidos os botões de serviços pagos indisponíveis das telas comuns. O servidor continua protegendo as operações.
- Cartazes abrem detalhes; botões Assistir/Continuar iniciam o vídeo. Detalhes recolhem versões, áudio e legendas; títulos indisponíveis exibem saída clara. Continuar assistindo mostra minutos restantes.
- Imagens possuem estado de carregamento e alternativa quando falham; catálogo tem skeleton; busca vazia permite limpar filtros; erros do player oferecem tentar novamente, outra versão ou voltar ao catálogo.
- Texto pequeno, contraste, foco visível, alvos de toque e redução de movimento revisados. Prévia conferida em 390 × 844: navegação, busca vazia, detalhes e perfil de usuário sem administração.
- Ambos os players têm play/pause centralizado. No alternativo móvel, tocar no vídeo alterna mostrar/ocultar controles, inclusive durante pausa. Removidos a tela grande de pausa e os gestos de brilho que mantinham um filtro escuro após o toque. O player nativo oculta os controles inferior e central juntos.
- 72 testes passaram, incluindo três verificações de renderização/estados da UI; TypeScript, builds web/nativo, compilação Swift, assinatura e upload concluídos. O build web local foi repetido com sucesso após encerrar a prévia para liberar memória.
- Produção Cloudflare: `08f84ce6-2296-4c84-a9de-015e40066b3f`. Catálogo HTTP 200 sem código; administração sem sessão HTTP 401; modo Workers + Neon preservado.
- Conferir no aparelho: dois toques separados mostram/escondem controles, brilho original preservado, play/pause central, legendas, rotação, retomada e tela sem relógio durante o filme.


## Reprodução móvel e fluidez — 21/10/2026

- Commit `849fb7ef8bb5f0a9ae05deadbc11a8245a575c84`; build iOS 1.0 (8): https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad95ee78a524d15d6a5dc04
- Player alternativo iOS inicia expandido. No móvel, removidos atalhos superiores de áudio/legendas e tela cheia, assim como o botão inferior de alternar tela cheia. Duplo toque não reduz o player; Voltar continua saindo do filme.
- Toques no vídeo a até 28 pontos/pixels das bordas não alternam os controles. Ambos os players escondem os controles após dois segundos; novo toque central esconde imediatamente. Áudio/legendas permanece no menu inferior.
- Canvas mantém o relógio de áudio atualizado a cada quadro, mas limita notificações à UI a quatro por segundo, evitando renderizações React a cada quadro. Teste garante os dois quadros exibidos e relógio atualizado apesar de uma única notificação à interface.
- Player nativo faz a busca ao soltar a barra, evitando reiniciar o decodificador a cada movimento do dedo.
- TypeScript, 73 testes e builds web/nativo passaram localmente. Fluidez e proteção contra toques devem ser conferidas no iPhone; os testes locais não medem quadros no aparelho.
- Produção Cloudflare: `9fa06426-99b5-492b-8c4b-fa118fb9b49b`. Sessão pública viewer e catálogo HTTP 200; administração HTTP 401 sem sessão. Workers + Neon restrito preservado.
- Compilação Swift, assinatura e upload Apple concluídos no CI em 2m58s. Apple processou o build `6e5b4c30-6c3f-4043-98aa-d23bb4f3ece3` e o associou ao grupo interno `MinattoFlix - Teste pessoal` (1 testador). Roteiro de teste salvo no App Store Connect.
- Confirmado **Em testes** no grupo interno. Comprovante: `docs/testflight-build8-liberado.png`.

## Idioma, orientação fixa e bloqueio da tela — 21/10/2026

- Commit `6a24b7ff0285796da00ccfbe89ddae223323d84a`; build 1.0 (9): https://codemagic.io/app/6ad6cdb86a483b360aff08eb/build/6ad965dd8a524d15d6a5dd60
- Todo título começa sem legendas, ignorando seleção salva e legendas padrão/forçadas. Português (Brasil) e variantes pt/por/pob têm prioridade de áudio; versões com faixa portuguesa conhecida têm prioridade sobre originais sem dublagem. Isso não cria uma faixa ausente no arquivo nem remove legendas gravadas na imagem.
- AVPlayer seleciona português e desativa seleção automática de idioma/legendas do sistema. O menu continua permitindo escolhas manuais durante a sessão.
- iOS fixa a reprodução em landscapeRight e restaura portrait no catálogo. O player alternativo usa a orientação nativa, sem somar rotação CSS ao acelerômetro. Implementado com máscara de orientações e requestGeometryUpdate no iOS 16+, com guarda para o deployment target 15.
- SceneDelegate avisa quando a cena perde atividade; plugin pausa AVPlayer e avisa o player web. Visibility/pagehide pausam vídeo, canvas e áudio externo/WASM. Retornar ao app não retoma automaticamente; preparação assíncrona concluída após bloqueio também não inicia reprodução.
- TypeScript, 76 testes e builds web/nativo passaram localmente. Testes cobrem seleção portuguesa, escolha de versão dublada, legendas desligadas apesar de progresso salvo e pausa sem retomada na visibilidade.
- Produção Cloudflare: `8d59e1ad-bc63-4254-a4fd-b4387b55b99e`. Sessão e catálogo HTTP 200; administração sem sessão HTTP 401. Workers + Neon restrito preservado.
- Validar no iPhone: balançar/girar aparelho durante filme sem reduzir o player; bloquear durante reprodução e também durante carregamento; desbloquear e confirmar pausa até tocar Play; ouvir português e conferir ausência de legendas.
- Referência UIKit: https://developer.apple.com/documentation/uikit/uiwindowscene/requestgeometryupdate(_:errorhandler:), https://developer.apple.com/documentation/uikit/uiviewcontroller/supportedinterfaceorientations
- CI concluiu compilação Swift, assinatura e upload em 3m09s; build 9 recebido pela Apple.
- Build Apple `c5eb4034-465b-4cf9-a80a-ead14870f865` processado e associado ao grupo interno `MinattoFlix - Teste pessoal` (1 testador). Roteiro específico registrado no App Store Connect.
- Confirmado **Em testes** no grupo interno; comprovante `docs/testflight-build9-liberado.png`. Atualizar MinattoFlix para 1.0 (9) no TestFlight e executar validação física.
