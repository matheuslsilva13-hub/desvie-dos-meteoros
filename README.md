# Desvie dos Meteoros

Jogo 2D multiplayer de sobrevivência em arena 800 × 600. O servidor Node.js + Express + Socket.io é a fonte da verdade; o cliente usa JavaScript puro e Canvas 2D. Os jogadores precisam evitar meteoros que surgem de fora da arena e ficam mais frequentes e rápidos com o passar da rodada.

## Começar localmente

Requer Node.js 18 ou superior.

```bash
npm install
npm test
npm start
```

Abra `http://localhost:3000` em duas ou mais abas ou dispositivos na mesma rede. Para encerrar o servidor, use `Ctrl+C`. O servidor também responde em `GET /healthz`, útil como health check.

## Arquitetura e regras

- **HTTP e WebSockets:** o Express entrega a página, CSS, JavaScript e imagens via HTTP. Socket.io mantém uma conexão persistente para enviar inputs e snapshots sem abrir uma requisição HTTP nova para cada atualização.
- **Eventos Socket.io:** `io.on('connection')` aceita conexões; `socket.emit` envia o estado inicial e erros apenas a um cliente; `socket.broadcast.emit` anuncia entrada/saída aos demais; `io.emit` distribui snapshots e mudanças da partida a todos.
- **Renderização e simulação:** `requestAnimationFrame()` desenha o Canvas no ritmo do navegador. O servidor simula em tick fixo de 60 Hz com `setInterval`. Separar render e simulação evita fazer a física depender da taxa de quadros de cada aparelho. Um tick fixo também consolida e limita as atualizações da sala; emitir um evento por tecla pode gerar tráfego irregular e torna a movimentação dependente da repetição do teclado.
- **Fonte da verdade e estados:** o navegador envia somente quatro booleanos de intenção (`up`, `down`, `left`, `right`). Posições, limites, colisões, sobrevivência, meteoros e vitórias são calculados no servidor. A máquina de estados é `AGUARDANDO` → contagem regressiva de 3 s → `EM_JOGO` → `FIM_DE_RODADA` por 5 s → nova contagem e rodada automática. A rodada aguarda pelo menos dois pilotos; termina sem vencedor quando todos os participantes são atingidos ou com vitória quando resta um único sobrevivente.

A cada tick o servidor normaliza movimento diagonal, prende jogadores à arena, move/descarta meteoros, verifica colisões circulares e envia um snapshot. Quem é atingido continua conectado e pode se mover como fantasma até a próxima rodada. Jogadores que entram no meio de uma rodada ficam como espectadores fantasma até a rodada seguinte.

O estado da partida e as vitórias ficam em memória no processo Node. Isso atende à sala única deste projeto; um reinício do processo reinicia os dados e uma implantação horizontal exige coordenação compartilhada entre instâncias.

## Estrutura

```text
.
├── package.json
├── package-lock.json
├── server.js
├── README.md
├── LICENSE
├── test/
│   └── server.test.js
└── public/
    ├── index.html
    ├── style.css
    ├── client.js
    ├── manus-routes.json
    └── assets/
        ├── CREDITS.md
        ├── arena-nebula.png
        ├── ship-nova.png
        ├── ship-comet.png
        └── ship-pulse.png
```

## Publicar gratuitamente no Render

Crie um repositório Git com estes arquivos e, no Render, escolha **New → Web Service** e conecte o repositório. Use:

- **Runtime:** Node.
- **Build Command:** `npm ci` (usa o `package-lock.json`; `npm install` também funciona).
- **Start Command:** `npm start`.
- **Compute plan:** Free, se disponível para sua conta/região.
- **Root Directory:** raiz do projeto (ou a subpasta do jogo, se o repositório tiver outros projetos).
- **Porta:** não fixe uma porta no painel. O Render define `PORT`; o servidor usa `process.env.PORT || 3000` e escuta em `0.0.0.0`.

Após o deploy, acesse a URL HTTPS gerada pelo Render. O serviço atende HTTP e Socket.io no mesmo listener; o cliente conecta à mesma origem. O plano Free do Render é adequado a testes/hobby, não a produção contínua: serviços sem tráfego podem suspender após 15 minutos e levar cerca de um minuto para voltar. Para um lançamento de produção, use um plano com disponibilidade adequada; reinícios também apagam o estado de partida mantido em memória.

## Assets e licenças

Os quatro PNGs de jogo são sprites 2D do pack **Space Shooter Redux**, de **Kenney / Kenney.nl**. O pack está identificado como **CC0 (domínio público)** na página de distribuição do GDevelop e foi publicado no OpenGameArt pelo autor, que indica crédito a Kenney.nl como não obrigatório. O projeto dá crédito de qualquer forma. CC0 permite copiar, modificar e redistribuir inclusive para fins comerciais; consulte o texto da licença para os termos completos.

1. **Nave Nova** — arquivo `public/assets/ship-nova.png`, derivado do membro `PNG/playerShip1_blue.png`.
2. **Nave Comet** — arquivo `public/assets/ship-comet.png`, derivado do membro `PNG/playerShip2_green.png`.
3. **Nave Pulse** — arquivo `public/assets/ship-pulse.png`, derivado do membro `PNG/playerShip3_red.png`.
4. **Mapa de fundo espacial** — arquivo `public/assets/arena-nebula.png`, derivado do membro `Backgrounds/darkPurple.png`.

**Fonte do pack e autor:** [Space Shooter Redux — OpenGameArt](https://opengameart.org/content/space-shooter-redux) · [página do pack e licença CC0 — GDevelop, por Kenney](https://gdevelop.io/asset-store/free/space-shooter-redux-space-shooter) · [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). Os meteoros são desenhados proceduralmente no Canvas, sem imagem externa.

## Testes

`npm test` usa o test runner nativo do Node e clientes Socket.io para cobrir limites e movimento diagonal, colisão, movimento de fantasmas, geração/dificuldade dos meteoros, contagem regressiva, transições e reinício de rodada, vitórias, desconexão, payloads inválidos e entrega HTTP dos arquivos estáticos/assets.
