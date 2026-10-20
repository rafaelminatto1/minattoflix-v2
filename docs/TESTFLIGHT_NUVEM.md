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
- A atribuição automática falhou: a API Apple recusou adicionar o build ao grupo interno `MinattoFlix - Teste pessoal` (`Cannot add internal group to a build`). A instalação pelo grupo precisa de confirmação no App Store Connect; o upload e processamento já foram concluídos.
- Removida essa atribuição incompatível do YAML para os próximos envios. Para o grupo interno, habilitar distribuição automática ou adicionar o build pela interface Apple.
- Workers + Neon permanece restrito: processamento GitHub, R2 e IA desativados. A preparação de vídeos é local. Sincronismo, interrupções e reprodução precisam de teste físico no iPhone.

