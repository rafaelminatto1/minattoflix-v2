# Primeiro app no MacBook: guia para começar do zero

## Quando ir para o Mac

A interface, o backend, os testes e a preparação do bundle podem continuar no Windows. O próximo ponto que exige o Mac é **compilar o projeto iOS pela primeira vez e testar no seu iPhone**. Esse teste confirma aspectos que o navegador do Windows não confirma: WKWebView, áudio, codecs, áreas seguras e assinatura.

Esta entrega prepara essa etapa. Não foi compilada em Xcode nem enviada ao TestFlight no Windows.

## 1. Instalar as ferramentas

1. No MacBook, abra a App Store e instale **Xcode 26 ou superior**, conforme o requisito do Capacitor 8. Se não estiver disponível para seu macOS, confira a compatibilidade do Mac antes de prosseguir.
2. Abra o Xcode, aceite os termos e deixe instalar os componentes adicionais. Se ele perguntar sobre plataformas, instale **iOS**, incluindo o simulador.
3. Instale **Node.js 24 LTS** pelo instalador oficial em https://nodejs.org. Feche e reabra o Terminal após instalar.
4. Instale **GitHub Desktop** em https://desktop.github.com e entre na conta GitHub que contém o repositório privado.
5. Abra **Terminal**, encontrado em Aplicativos > Utilitários. Confira:

```sh
node --version
npm --version
xcodebuild -version
```

Se `xcodebuild` indicar que está usando apenas Command Line Tools, selecione Xcode > Settings > Locations > Command Line Tools e escolha o Xcode instalado. Não precisa de CocoaPods: este projeto usa Swift Package Manager.

## 2. Baixar o projeto

1. No GitHub Desktop, escolha **File > Clone Repository**.
2. Na aba GitHub.com, procure **rafaelminatto1/minattoflix-v2**.
3. Escolha a pasta local `~/Documents/GitHub/minattoflix-v2` e clique **Clone**.
4. No Terminal, execute os comandos abaixo, um por vez. Se escolheu outra pasta, ajuste o primeiro comando.

```sh
cd ~/Documents/GitHub/minattoflix-v2
npm ci
npm run typecheck
npm test
npm run ios:prepare
npm run ios:open
```

`ios:prepare` compila a interface e a copia para o projeto iOS. `ios:open` abre o projeto já criado; você **não deve escolher Create a new Xcode project**. Não precisa executar `ios:add`, porque a pasta iOS já está no GitHub.

O app acessa o servidor atual via HTTPS. Não copie `.dev.vars` nem chaves do servidor para o Mac para executar esta versão do app.

## 3. Conhecer a tela do Xcode

- **Coluna esquerda:** arquivos do projeto. O item azul chamado **App** abre as configurações.
- **Parte superior:** esquema **App**, aparelho/simulador de destino e botão triangular **Run**.
- **Centro:** arquivo ou configuração selecionada.
- **Área inferior:** mensagens de compilação e console. Erros aparecem também no navegador de problemas, pelo ícone de alerta na lateral esquerda.

Espere o Xcode resolver os pacotes antes de clicar Run. Na primeira abertura isso pode levar alguns minutos.

## 4. Executar no simulador

1. No seletor de destino, ao lado do esquema **App**, escolha **iPhone 15** se disponível. Se o Xcode oferecer outro iPhone, ele também serve para o primeiro teste; simuladores adicionais podem ser instalados em Settings > Components.
2. Clique no triângulo **Run**, ou pressione **Command + R**.
3. Aguarde a compilação. O aplicativo deve abrir no simulador e carregar o catálogo do servidor.
4. Teste navegação, busca, filtros, detalhes e rotação de tela.

O simulador não é a confirmação final de codecs ou áudio. Precisamos também do iPhone físico.

## 5. Configurar a conta Apple e a assinatura

1. No Xcode, abra **Settings > Accounts** e adicione seu Apple Account associado ao Apple Developer Program.
2. Na coluna esquerda, clique no item azul **App**.
3. Na área central, em **TARGETS**, selecione **App**.
4. Abra **Signing & Capabilities**.
5. Marque **Automatically manage signing**.
6. Em **Team**, escolha sua equipe Apple Developer.
7. Confirme o **Bundle Identifier**: `com.rafaelminatto.minattoflix`.

Se a Apple informar que esse identificador já pertence a outra equipe, escolha um identificador disponível e atualize tanto essa configuração quanto `capacitor.config.ts`. Depois execute `npm run ios:prepare`. Não mude esse identificador após registrar e distribuir o app sem planejar a mudança de identidade.

## 6. Executar no seu iPhone

1. Conecte o iPhone ao Mac com cabo e desbloqueie-o.
2. Confirme **Confiar neste computador** no iPhone, se solicitado.
3. No iPhone, habilite **Ajustes > Privacidade e Segurança > Modo de Desenvolvedor** se o Xcode pedir. Siga o reinício e a confirmação exibidos pelo aparelho.
4. No Xcode, escolha seu iPhone no seletor de destino.
5. Clique **Run** e deixe o Xcode registrar/configurar o aparelho.

Se houver erro, copie a primeira mensagem vermelha completa do navegador de problemas. Não compartilhe certificados, tokens nem chaves privadas.

## 7. O que validar antes do TestFlight

- Catálogo, capas, busca e filtros carregam.
- Vídeo inicia após toque e apresenta imagem em movimento.
- Apenas a faixa selecionada toca; mudar português/inglês não mistura as duas.
- Pausa, retomada, avanço, legendas e rotação funcionam.
- Controles não ficam sob Dynamic Island ou barra inferior.
- Fechar o player interrompe a reprodução.

Esta versão ainda usa o player web existente dentro do app. Se MKV/Dolby falhar no aparelho, a próxima etapa será trabalhar no pipeline de reprodução e/ou numa integração nativa. O Capacitor, sozinho, não adiciona um decodificador novo.

## 8. Enviar ao TestFlight, depois do teste no aparelho

1. Acesse https://appstoreconnect.apple.com com a mesma conta Apple.
2. Em **Apps > + > New App**, cadastre **MinattoFlix**, idioma Português (Brasil), plataforma iOS e o Bundle ID registrado pela sua equipe. Use um SKU próprio, por exemplo `minattoflix-ios-001`.
3. No Xcode, em **TARGETS > App > General**, confira **Version** e **Build**. Para a primeira versão, use `1.0` e `1`. Aumente o Build a cada novo envio.
4. Use um ícone original opaco de 1024 × 1024. A base inclui um ícone derivado do símbolo M do próprio projeto; revise-o antes do envio.
5. No seletor de destino, escolha **Any iOS Device (arm64)** ou o destino genérico equivalente.
6. Escolha **Product > Archive**. Se estiver indisponível, você provavelmente ainda selecionou um simulador.
7. Ao terminar, abra o **Organizer**, selecione o arquivo gerado e clique **Distribute App**. Escolha **App Store Connect**, depois o envio/upload oferecido pelo Xcode.
8. Após o processamento no App Store Connect, abra **TestFlight**, complete as informações solicitadas e configure os testadores. Responda as perguntas sobre exportação/criptografia de acordo com os recursos reais do app.
9. Para testadores externos, o primeiro build precisa de revisão beta. O build expira após 90 dias.

Antes de distribuir, confira política de privacidade, direitos de uso do conteúdo e informações de revisão. A preparação do projeto não significa aprovação da Apple.

## 9. Como continuar desenvolvendo por aqui

O fluxo depois do primeiro teste será:

1. Desenvolver e verificar o código no Windows.
2. Enviar as alterações ao GitHub.
3. No GitHub Desktop do Mac, usar **Fetch origin**, depois **Pull origin**.
4. No Terminal do Mac, executar:

```sh
npm ci
npm run ios:prepare
npm run ios:open
```

5. Executar no iPhone. Para um novo TestFlight, aumentar o Build e gerar outro Archive.

Os arquivos `dist`, assets web copiados, configurações locais do Xcode e credenciais não são versionados; são reconstruídos nesse processo.

## Referências oficiais

- Capacitor: https://capacitorjs.com/docs/ios
- Ambiente de desenvolvimento: https://capacitorjs.com/docs/getting-started/environment-setup
- Distribuição iOS: https://capacitorjs.com/docs/ios/deploying-to-app-store
- Executar em simulador/aparelho: https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices
- TestFlight: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
