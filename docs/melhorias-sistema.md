# Melhorias de navegação e catálogo

## Comportamento implementado

- Carrosséis avançam por cartões, encaixam a posição, indicam os limites e aceitam setas, Home e End quando a área recebe foco.
- Painéis bloqueiam a rolagem da página, mantêm o foco e fecham com Escape. O foco retorna ao controle anterior.
- As seções preservam sua posição de rolagem. A busca no celular tem uma faixa própria.
- A busca ignora acentos e consulta títulos, elenco, gênero, arquivos, idiomas e qualidade.
- A grade tem filtros por gênero, ano, idioma de áudio e resolução; ordenação por título, nota, ano e adição; e renderiza 48 itens por etapa.
- Os painéis e o player carregam em arquivos JavaScript separados. A API inicial omite temporadas e episódios; detalhes completos são consultados por título.
- O progresso é atualizado sem recarregar o catálogo. Há remoção de Continuar assistindo por perfil.
- Falhas de HTTP geram mensagens. Minha Lista desfaz a alteração otimista quando a gravação falha.
- Selos usam os metadados disponíveis: resolução não implica HDR, quantidade de faixas não implica idiomas ou canais, e nota não é apresentada como relevância pessoal.
- Recentes seguem a data de adição. O ranking contém até dez títulos ordenados por nota.
- Episódios exigem arquivos vinculados. Não há mais offsets estimados de 20 minutos. A seleção do episódio agora chega ao player.
- O player limita as tentativas automáticas entre arquivos que falharam e trata erros nas operações de legenda.
- O decodificador Dolby é baixado apenas quando uma faixa AC-3/E-AC-3 precisa dele; o arquivo inicial do player caiu de aproximadamente 1,43 MB para 282 kB no build, antes da compressão.
- Preferência por movimento reduzido, foco visível, imagens preguiçosas e renderização adiada de cartões fora da tela.

CORS foi mantido e não foi adicionada autenticação.

## Desenvolvimento e configuração

`npm run dev:local` inicia o Worker local sem a conexão de bindings remotos ou Hyperdrive. O acesso ao banco continua usando `DATABASE_URL`; este comando não cria um banco local. Recursos de IA que dependem da Cloudflare devem ser validados com o ambiente remoto configurado.

A conexão existente foi preservada em `.dev.vars`, ignorado pelo Git. Não existe mais senha padrão no código nem no arquivo Wrangler. Antes de publicar, configure `DATABASE_URL` como segredo do Worker e substitua a senha anteriormente exposta. A rotação da senha e a configuração remota não foram executadas nesta alteração local.

O diretório público do build é `dist/client`; os arquivos do Worker ficam em `dist/minattoflix_v2`. Não publique arquivos `.dev.vars`. Veja a [documentação de secrets da Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/).

## Validação

- `npm run typecheck`
- `npm test`: onze testes de áudio, busca, qualidade, erros HTTP e API. A API usa SQL simulado, sem gravações em banco real.
- `npm run build`
- Leitura da API local conectada ao banco existente: catálogo com onze títulos e detalhes retornaram HTTP 200. Os campos `media_items.created_at` e `media_files.episode_id` foram confirmados por consulta de esquema, sem migração ou gravação.
- `playwright-cli -s=minatto-audit run-code --filename=tests/ui-validation.js`, após abrir a sessão e iniciar o servidor local. A interface usa 65 títulos simulados e valida limites dos carrosséis, teclado, retorno da rolagem, grade, qualidade, carregamento de detalhes, foco, Escape, reversão de Minha Lista, remoção de progresso e busca no celular.

Capturas: `ui-desktop-validation.png` e `ui-mobile-validation.png`, com dados fictícios. O cabeçalho com busca expandida foi verificado em larguras de 320, 390, 640, 768, 1024 e 1440 pixels. A reprodução real de arquivos de nuvem, IA e desempenho com o acervo de produção ainda dependem de validação no ambiente real.
