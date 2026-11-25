'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: createClient } = require('socket.io-client');
const {
  createGameServer,
  validateJoinPayload,
  validateInputPayload,
  clampPlayerToArena,
  checkPlayerMeteorCollision,
  getDifficulty,
  constants
} = require('../server');

const silentLogger = { info() {}, warn() {}, error() {} };
let runtime;
let nowValue;
let baseUrl;
const clients = [];

function waitFor(socket, eventName, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout aguardando o evento "${eventName}"`));
    }, timeoutMs);
    function listener(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(eventName, listener);
      resolve(payload);
    }
    socket.on(eventName, listener);
  });
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000
    });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timeout conectando cliente de teste'));
    }, 2500);
    socket.once('connect', () => {
      clearTimeout(timeout);
      clients.push(socket);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function join(socket, payload = { nickname: 'Piloto', character: 'nova' }) {
  const ready = waitFor(socket, 'initState');
  socket.emit('joinGame', payload);
  return ready;
}

function getRequest(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

beforeEach(async () => {
  nowValue = 1_000_000;
  runtime = createGameServer({
    now: () => nowValue,
    random: () => 0.4,
    logger: silentLogger
  });
  const address = await runtime.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await runtime.close();
});

describe('Desvie dos Meteoros — física e regras', () => {
  it('limita o centro do jogador à arena 800 × 600, descontando o raio', () => {
    const player = { x: -50, y: 900, radius: 20 };
    const clamped = clampPlayerToArena(player);
    assert.equal(clamped.x, 20);
    assert.equal(clamped.y, 580);

    clamped.x = 5000;
    clamped.y = -20;
    clampPlayerToArena(clamped);
    assert.equal(clamped.x, 780);
    assert.equal(clamped.y, 20);
  });

  it('normaliza movimento diagonal e não excede a velocidade cardinal', () => {
    const player = { x: 400, y: 300, radius: 20, alive: true };
    runtime.movePlayer(player, { up: false, down: true, left: false, right: true }, 1 / 60);
    const distance = Math.hypot(player.x - 400, player.y - 300);
    assert.ok(Math.abs(distance - constants.PLAYER_SPEED / 60) < 1e-8);
    assert.ok(Math.abs((player.x - 400) - (player.y - 300)) < 1e-8);
  });

  it('detecta colisão circular jogador-meteoro e ignora fantasmas', () => {
    const player = { x: 100, y: 100, radius: 20, alive: true };
    const touching = { x: 140, y: 100, radius: 20 };
    const far = { x: 141, y: 100, radius: 20 };
    assert.equal(checkPlayerMeteorCollision(player, touching), true);
    assert.equal(checkPlayerMeteorCollision(player, far), false);
    assert.equal(checkPlayerMeteorCollision({ ...player, alive: false }, touching), false);
  });

  it('um piloto fantasma continua podendo se mover sem ultrapassar as bordas', () => {
    const ghost = { x: 200, y: 180, radius: 20, alive: false };
    runtime.movePlayer(ghost, { up: false, down: false, left: false, right: true }, 1 / 60);
    assert.equal(ghost.alive, false);
    assert.ok(ghost.x > 200);
    assert.ok(ghost.x <= constants.ARENA.width - ghost.radius);
  });

  it('gera meteoros fora de uma borda e aumenta velocidade/frequência ao longo do tempo', () => {
    const meteor = runtime.spawnMeteor();
    assert.ok(meteor.x < 0 || meteor.x > constants.ARENA.width || meteor.y < 0 || meteor.y > constants.ARENA.height);
    assert.ok(Math.hypot(meteor.vx, meteor.vy) >= constants.BASE_METEOR_SPEED);
    const early = getDifficulty(0);
    const later = getDifficulty(30);
    assert.ok(later.speed > early.speed);
    assert.ok(later.spawnIntervalMs < early.spawnIntervalMs);
  });
});

describe('Desvie dos Meteoros — validação', () => {
  it('aceita nickname/personagem válidos e aplica padrões somente para campos ausentes', () => {
    assert.deepEqual(validateJoinPayload({ nickname: '  Lua  ', character: 'comet' }, 'abc123'), {
      ok: true,
      value: { nickname: 'Lua', character: 'comet' }
    });
    const defaults = validateJoinPayload({}, 'abc123');
    assert.equal(defaults.ok, true);
    assert.equal(defaults.value.character, constants.DEFAULT_CHARACTER);
    assert.match(defaults.value.nickname, /^Piloto_/);
  });

  it('rejeita tipos malformados, nickname vazio/longo e personagem inexistente', () => {
    assert.equal(validateJoinPayload(['x'], 'abc').code, 'INVALID_JOIN_PAYLOAD');
    assert.equal(validateJoinPayload({ nickname: 9 }, 'abc').code, 'INVALID_NICKNAME');
    assert.equal(validateJoinPayload({ nickname: '   ' }, 'abc').code, 'INVALID_NICKNAME');
    assert.equal(validateJoinPayload({ nickname: 'x'.repeat(17) }, 'abc').code, 'INVALID_NICKNAME');
    assert.equal(validateJoinPayload({ nickname: 'ok', character: 'dragon' }, 'abc').code, 'INVALID_CHARACTER');
  });

  it('aceita apenas os quatro controles como booleanos e rejeita direções/tipos desconhecidos', () => {
    assert.deepEqual(validateInputPayload({ up: true, down: false, left: false, right: true }), {
      up: true, down: false, left: false, right: true
    });
    assert.equal(validateInputPayload({ up: 'true', down: false, left: false, right: false }), null);
    assert.equal(validateInputPayload({ up: false, down: false, left: false, right: false, teleport: true }), null);
    assert.equal(validateInputPayload(null), null);
  });

  it('responde a entradas inválidas por Socket.io sem encerrar a conexão/servidor', async () => {
    const client = await connectClient();
    const controlsBeforeJoin = waitFor(client, 'serverError', (error) => error.code === 'PLAYER_NOT_JOINED');
    client.emit('playerInput', { up: false, down: false, left: false, right: false });
    assert.equal((await controlsBeforeJoin).code, 'PLAYER_NOT_JOINED');

    const badJoin = waitFor(client, 'serverError', (error) => error.code === 'INVALID_JOIN_PAYLOAD');
    client.emit('joinGame', ['payload inválido']);
    assert.equal((await badJoin).code, 'INVALID_JOIN_PAYLOAD');

    const badName = waitFor(client, 'serverError', (error) => error.code === 'INVALID_NICKNAME');
    client.emit('joinGame', { nickname: '   ', character: 'nova' });
    assert.equal((await badName).code, 'INVALID_NICKNAME');

    const badCharacter = waitFor(client, 'serverError', (error) => error.code === 'INVALID_CHARACTER');
    client.emit('joinGame', { nickname: 'Válido', character: 'inexistente' });
    assert.equal((await badCharacter).code, 'INVALID_CHARACTER');

    const init = await join(client, { nickname: 'Válido', character: 'nova' });
    const id = init.playerId;
    const badDirection = waitFor(client, 'serverError', (error) => error.code === 'INVALID_INPUT');
    client.emit('playerInput', { up: 'sim', down: false, left: false, right: false });
    assert.equal((await badDirection).code, 'INVALID_INPUT');
    assert.equal(runtime.players[id].x, init.players[id].x);
    assert.equal(runtime.players[id].y, init.players[id].y);
    assert.equal(runtime.gameState, constants.GAME_STATES.WAITING);
    assert.equal((await getRequest('/healthz')).status, 200);
  });
});

describe('Desvie dos Meteoros — integração e máquina de estados', () => {
  it('serve HTML, cliente, Socket.io e os quatro assets visuais', async () => {
    const paths = [
      '/', '/style.css', '/client.js', '/socket.io/socket.io.js', '/healthz',
      '/assets/arena-nebula.png', '/assets/ship-nova.png', '/assets/ship-comet.png', '/assets/ship-pulse.png'
    ];
    for (const pathname of paths) {
      const response = await getRequest(pathname);
      assert.equal(response.status, 200, `HTTP 200 esperado em ${pathname}`);
      assert.ok(response.body.length > 0, `Conteúdo vazio em ${pathname}`);
    }
  });

  it('aguarda dois pilotos, inicia após 3 s, elimina por colisão e reinicia após 5 s', async () => {
    const first = await connectClient();
    const second = await connectClient();
    const firstInit = await join(first, { nickname: 'Nova', character: 'nova' });
    const secondInit = await join(second, { nickname: 'Comet', character: 'comet' });
    const firstId = firstInit.playerId;
    const secondId = secondInit.playerId;

    assert.equal(runtime.gameState, constants.GAME_STATES.WAITING);
    assert.equal(runtime.getSnapshot().countdownSeconds, 3);
    assert.equal(runtime.players[firstId].alive, true);

    nowValue += constants.COUNTDOWN_MS;
    runtime.tick();
    assert.equal(runtime.gameState, constants.GAME_STATES.PLAYING);
    assert.equal(runtime.roundNumber, 1);
    assert.equal(runtime.players[firstId].alive, true);
    assert.ok(runtime.meteors.length >= 1);

    const lateClient = await connectClient();
    const lateJoin = await join(lateClient, { nickname: 'Espectro', character: 'pulse' });
    assert.equal(runtime.players[lateJoin.playerId].alive, false);

    runtime.players[firstId].x = 240;
    runtime.players[firstId].y = 220;
    runtime.players[secondId].x = 660;
    runtime.players[secondId].y = 500;
    runtime.meteors.push({ id: 9999, x: 240, y: 220, vx: 0, vy: 0, radius: 25 });
    runtime.tick();

    assert.equal(runtime.players[firstId].alive, false);
    assert.equal(runtime.players[secondId].alive, true);
    assert.equal(runtime.gameState, constants.GAME_STATES.ROUND_OVER);
    assert.deepEqual(runtime.winner, { id: secondId, nickname: 'Comet' });
    assert.equal(runtime.players[secondId].wins, 1);

    nowValue += constants.ROUND_OVER_MS;
    runtime.tick();
    assert.equal(runtime.gameState, constants.GAME_STATES.WAITING);
    assert.equal(runtime.players[firstId].alive, true);
    assert.equal(runtime.players[secondId].alive, true);
    assert.equal(runtime.players[lateJoin.playerId].alive, true);
    assert.equal(runtime.players[firstId].survivalTime, 0);
    assert.equal(runtime.players[secondId].wins, 1);
    assert.equal(runtime.getSnapshot().countdownSeconds, 3);

    nowValue += constants.COUNTDOWN_MS;
    runtime.tick();
    assert.equal(runtime.gameState, constants.GAME_STATES.PLAYING);
    assert.equal(runtime.roundNumber, 2);
  });

  it('termina sem vencedor quando todos os participantes vivos são atingidos', async () => {
    const first = await connectClient();
    const second = await connectClient();
    const a = await join(first, { nickname: 'A', character: 'nova' });
    const b = await join(second, { nickname: 'B', character: 'pulse' });
    nowValue += constants.COUNTDOWN_MS;
    runtime.tick();

    runtime.players[a.playerId].x = 200;
    runtime.players[a.playerId].y = 200;
    runtime.players[b.playerId].x = 600;
    runtime.players[b.playerId].y = 450;
    runtime.meteors.push(
      { id: 5001, x: 200, y: 200, vx: 0, vy: 0, radius: 24 },
      { id: 5002, x: 600, y: 450, vx: 0, vy: 0, radius: 24 }
    );
    runtime.tick();
    assert.equal(runtime.gameState, constants.GAME_STATES.ROUND_OVER);
    assert.equal(runtime.winner, null);
    assert.equal(runtime.players[a.playerId].alive, false);
    assert.equal(runtime.players[b.playerId].alive, false);
  });

  it('remove o jogador desconectado e notifica os demais', async () => {
    const first = await connectClient();
    const second = await connectClient();
    await join(first, { nickname: 'Fica', character: 'nova' });
    const leaving = await join(second, { nickname: 'Sai', character: 'comet' });
    const leftEvent = waitFor(first, 'playerLeft', (player) => player.id === leaving.playerId);
    second.disconnect();
    const payload = await leftEvent;
    assert.equal(payload.nickname, 'Sai');
    assert.equal(runtime.players[leaving.playerId], undefined);
  });
});
