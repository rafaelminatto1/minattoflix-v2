# MinattoFlix V2

Interface React 19 + TypeScript + Tailwind, com backend Hono em Cloudflare Workers e uma base de app iOS em Capacitor.

## Começar

Use Node.js 24 LTS e instale as dependências:

```sh
npm ci
npm run typecheck
npm test
```

O site usa `npm run build` e `npm run deploy`. O backend precisa de recursos Cloudflare e credenciais locais; `.dev.vars` não faz parte do repositório.

## App iPhone

O app empacota a interface em `dist/native` e acessa a API HTTPS existente. Não precisa de credenciais de banco, Cloudflare ou Apple no bundle web.

```sh
npm run ios:prepare
```

No Mac, abra o projeto:

```sh
npm run ios:open
```

Leia [o passo a passo para quem nunca usou Xcode](docs/INICIAR_NO_MACBOOK.md). O projeto iOS está em `ios/App`; usa Swift Package Manager.

O identificador inicial é `com.rafaelminatto.minattoflix`. Confirme a disponibilidade na sua conta Apple antes de registrar o app.

O backend padrão é `https://minattoflix-v2.rafalegollas.workers.dev`. Para outra instância, configure `NATIVE_API_ORIGIN` antes de executar o build nativo. Essa variável aceita uma origem HTTPS sem caminhos nem credenciais.

## Estado desta versão

- Base Capacitor e comunicação com API preparadas.
- Build JavaScript e testes podem ser executados no Windows.
- Compilação Swift, assinatura, simulador e teste em iPhone exigem validação no Mac.
- O player ainda usa a implementação web existente. Não há garantia nova de suporte a MKV/Dolby pela simples instalação do app.
- O envio ao TestFlight é uma etapa posterior ao primeiro teste no dispositivo.

## Estrutura

| Diretório | Conteúdo |
| --- | --- |
| `src/client` | Interface e player |
| `src/worker` | API e streaming |
| `ios/App` | Projeto Xcode |
| `tests` | Testes de regressão |
| `docs` | Guias e validações |

Não versionar `.dev.vars`, `.env`, certificados, chaves Apple ou pastas de build. Instalar dependências e executar `ios:prepare` reconstrói os arquivos locais necessários.
