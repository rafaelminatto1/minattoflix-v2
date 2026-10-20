# Player nativo e preparação de mídia

Implementação de 20/10/2026. O archive Swift e a disponibilidade no TestFlight precisam ser confirmados por build.

## iPhone

O Capacitor registra `NativePlayer` no `MinattoBridgeViewController`. O AVPlayer/AVKit apresenta a reprodução fora da WebView, com controles do iOS, seleção das faixas disponíveis e um único motor para áudio/vídeo. O player começa após prontidão do item, busca da posição e preroll. O app recebe progresso a cada cinco segundos e ao sair ou entrar em background. A imagem começa com enquadramento completo.

A tela React `NativePlayback` verifica a disponibilidade da versão compatível. Quando não existe, mostra preparação e alternativa web. O fallback mantém o player existente para arquivos especiais. O processamento de codecs não acontece no iPhone.

Não declarar compatibilidade universal: codecs específicos, Dolby/HDR, legendas bitmap, interrupções e rotas Bluetooth precisam de validação física. PiP nativo não está habilitado nesta primeira implementação.

## Preparação local

Com Python e FFmpeg/FFprobe instalados:

```sh
python scripts/prepare_local.py "filme.mkv"
```

Gera `filme.compatible.mp4` ao lado do original. Um arquivo existente nunca é sobrescrito por essa ferramenta. O resultado usa H.264, AAC estéreo por faixa, até 720p e faststart. Faixas de áudio e idiomas são mantidos; legendas textuais compatíveis são convertidas para mov_text. Legendas gráficas não são incorporadas por este fluxo. HDR reconhecido recebe tone mapping para SDR.

Depois, envie a cópia à fonte da biblioteca e sincronize o catálogo. A compatibilidade final deve ser confirmada no dispositivo. O script valida codec, duração e decodificação inicial.

## Preparação em executor remoto

O workflow `.github/workflows/prepare-media.yml` executa FFmpeg no GitHub Actions, valida a saída e envia partes de 16 MiB ao Worker/R2. O original é somente lido. O arquivo só é publicado como pronto após a conclusão do multipart upload.

O executor usa identidade OIDC, restrita ao repositório e ao workflow em `main`, com audiência `minattoflix-media`. Credenciais Cloudflare não ficam no workflow nem no app. Endpoints de trabalho só aceitam o executor autenticado. O início da preparação precisa de autorização administrativa.

O código inclui armazenamento do estado em KV e entrega de MP4 com Range/HEAD no R2. Essa implementação gera uma cópia HD, não um catálogo de qualidades HLS adaptativas.

O modo de custos restritos presente nas alterações simultâneas mantém a preparação em nuvem desativada. Não desativar esse controle apenas para fazer o teste passar. A política de custos, os bindings e os middlewares de autenticação/tamanho de upload precisam ser conciliados antes de habilitar processamento remoto. O caminho local continua disponível sem processamento em nuvem.

Limites desta primeira versão: um trabalho por arquivo no grupo de concorrência do GitHub; arquivos maiores que a capacidade de disco do runner falham explicitamente; não há garantia de retomada da conversão após cancelamento do runner. A preparação deve ser iniciada uma vez por arquivo, com acompanhamento do trabalho.

## Validação

- Testes Node cobrem autenticação OIDC, ranges inválidos, publicação somente após conclusão e consultas de disponibilidade.
- `scripts/test_prepare_media.py` gera conteúdo sintético com vídeo, dois áudios e legenda. Verifica conversão, idiomas, faststart, seek e preservação do original. O job `media-preparer` no CI executa esse teste com FFmpeg.
- O build JavaScript nativo passou no Windows. Compilação Swift/assinatura precisam de Codemagic/Mac.
- Roteiro físico: início/retomada, troca de áudio e legenda, busca, pausa, saída, tela bloqueada, interrupção, AirPods e sessões longas. Testar também erro de rede e fallback web.

## Publicação coordenada

O usuário autorizou integrar nesta publicação as alterações de login, filas e política de custos. O login foi unificado; o modo restrito permanece ativo, com preparação local disponível e processamento remoto desativado. Nenhuma publicação deve ser descrita como concluída antes de identificar o commit, verificar o deploy Cloudflare e confirmar o novo build no TestFlight.
