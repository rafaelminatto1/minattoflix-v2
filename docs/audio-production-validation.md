# Validação de áudio em produção

URL: https://minattoflix-v2.rafalegollas.workers.dev

Versão final Cloudflare Workers: `ac59f683-831d-4845-8846-eb56d145df20`.

## Resultados

- Batman Azteca, OneDrive, EAC3 5.1: decoder WASM ativo, vídeo 1920 × 1080 e sinal medido na saída Web Audio.
- Faixas portuguesa e espanhola: ambas geraram sinal; o pico de saída observado na espanhola foi 0,474.
- Seek para 600 segundos: reprodução retomada com sinal de saída (pico observado 0,0669).
- Mudo: ganho e pico de saída zerados. Volume 35%: ganho 0,35 e sinal de saída presente.
- Pausa: sinal de saída zerado. Retomada: reprodução continuou.
- Mario, AAC 5.1: faixa padrão manteve reprodução nativa; faixa alternativa em inglês produziu sinal pelo caminho de decodificação de múltiplas faixas (pico observado 0,1184).
- Observação contínua da versão final no Batman: buffers enviados à saída cresceram de 322 para 1847, tempo de vídeo de 769,05 para 817,61 segundos, contexto de áudio `running`, ganho 1 e pico de saída 0,1838. Nenhum erro de console foi registrado nesse trecho.

## Ajuste encontrado durante a validação

Atualizações periódicas do catálogo recriavam os objetos das faixas e disparavam a inicialização de áudio novamente. A inicialização agora depende da URL e dos valores da faixa selecionada, evitando reiniciar o decoder quando apenas a identidade do objeto muda.

## Evidência e limites

Captura: `audio-production-validation.jpg`.

Validação de som baseada em buffers agendados e sinal medido após o controle de ganho, sem escuta humana. Os testes não cobrem todos os títulos, browsers ou duração completa dos filmes. A fonte Google Drive apresentou aviso de resposta sem HTTP 206; a validação EAC3 utilizou o mirror OneDrive.

Verificações locais: quatro testes do controlador, TypeScript e build de produção aprovados.
