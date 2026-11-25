'use strict';

/**
 * Servidor autoritativo de "Desvie dos Meteoros".
 * O cliente envia apenas intenções de movimento; posições, colisões, rodadas e vitórias
 * são calculadas aqui e distribuídas em snapshots com tick fixo de 60 Hz.
 */
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAME_STATES = Object.freeze({
  WAITING: 'AGUARDANDO',
  PLAYING: 'EM_JOGO',
  ROUND_OVER: 'FIM_DE_RODADA'
});
const CHARACTERS = Object.freeze(['nova', 'comet', 'pulse']);
const DEFAULT_CHARACTER = 'nova';
const COLORS = Object.freeze(['#56d9ff', '#ffca58', '#ff6e9d', '#a994ff', '#72efba', '#ff895e']);
const INPUT_DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const ARENA = Object.freeze({ width: 800, height: 600 });
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 255; // px/s; movimentos diagonais são normalizados.
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const COUNTDOWN_MS = 3000;
const ROUND_OVER_MS = 5000;
const MAX_NICKNAME_LENGTH = 16;
const MAX_PLAYERS = 32;
const BASE_METEOR_INTERVAL_MS = 950;
const MIN_METEOR_INTERVAL_MS = 180;
const BASE_METEOR_SPEED = 110;
const ZERO_INPUT = Object.freeze({ up: false, down: false, left: false, right: false });

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Mantém o centro do jogador dentro dos limites, respeitando o raio. */
function clampPlayerToArena(player) {
  player.x = clamp(player.x, player.radius, ARENA.width - player.radius);
  player.y = clamp(player.y, player.radius, ARENA.height - player.radius);
  return player;
}

/** Colisão circular; fantasmas não podem ser atingidos novamente. */
function checkPlayerMeteorCollision(player, meteor) {
  if (!player || player.alive !== true || !meteor) return false;
  const dx = player.x - meteor.x;
  const dy = player.y - meteor.y;
  const combinedRadius = player.radius + meteor.radius;
  return dx * dx + dy * dy <= combinedRadius * combinedRadius;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJoinPayload(payload, socketId) {
  const value = payload === undefined ? {} : payload;
  if (!isPlainObject(value)) {
    return { ok: false, code: 'INVALID_JOIN_PAYLOAD', message: 'Envie um objeto com nickname e character.' };
  }

  const nicknameWasSent = Object.hasOwn(value, 'nickname');
  let nickname;
  if (!nicknameWasSent) {
    nickname = `Piloto_${String(socketId).slice(0, 5)}`;
  } else if (typeof value.nickname !== 'string') {
    return { ok: false, code: 'INVALID_NICKNAME', message: 'O nickname precisa ser texto.' };
  } else {
    nickname = value.nickname.trim();
    const length = Array.from(nickname).length;
    if (!nickname || length > MAX_NICKNAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(nickname)) {
      return {
        ok: false,
        code: 'INVALID_NICKNAME',
        message: `Informe um nickname de 1 a ${MAX_NICKNAME_LENGTH} caracteres, sem caracteres de controle.`
      };
    }
  }

  const character = value.character === undefined ? DEFAULT_CHARACTER : value.character;
  if (typeof character !== 'string' || !CHARACTERS.includes(character)) {
    return { ok: false, code: 'INVALID_CHARACTER', message: 'Personagem inexistente. Escolha uma das opções disponíveis.' };
  }

  return { ok: true, value: { nickname, character } };
}

function validateInputPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.some((key) => !INPUT_DIRECTIONS.includes(key))) return null;
  if (!INPUT_DIRECTIONS.every((key) => typeof payload[key] === 'boolean')) return null;
  return {
    up: payload.up,
    down: payload.down,
    left: payload.left,
    right: payload.right
  };
}

function createGameServer(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const logger = options.logger || console;
  const tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : TICK_MS;

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
  });
  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
  app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: '1h', index: 'index.html' }));
  app.use((err, req, res, next) => {
    logger.error('[ERRO HTTP]', err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000
  });

  // Estado mutável, privado do servidor. Nunca se aceita posição informada pelo cliente.
  const players = {};
  const inputs = {};
  const meteors = [];
  let gameState = GAME_STATES.WAITING;
  let countdownEndsAt = null;
  let roundEndsAt = null;
  let roundStartedAt = null;
  let roundNumber = 0;
  let nextMeteorAt = null;
  let nextMeteorId = 1;
  let nextColor = 0;
  let tickIntervalId = null;
  let winner = null;
  let roundParticipantIds = new Set();

  function log(level, message, error) {
    if (error) logger[level](`[${level.toUpperCase()}] ${message}`, error);
    else logger[level](`[${level.toUpperCase()}] ${message}`);
  }

  function randomBetween(min, max) {
    return min + random() * (max - min);
  }

  function randomPosition(radius) {
    return {
      x: randomBetween(radius, ARENA.width - radius),
      y: randomBetween(radius, ARENA.height - radius)
    };
  }

  function createSnapshot() {
    const timestamp = now();
    const playerSnapshot = {};
    for (const [id, player] of Object.entries(players)) {
      playerSnapshot[id] = {
        id: player.id,
        x: player.x,
        y: player.y,
        radius: player.radius,
        color: player.color,
        nickname: player.nickname,
        character: player.character,
        alive: player.alive,
        survivalTime: Math.round(player.survivalTime * 100) / 100,
        wins: player.wins
      };
    }
    const countdownSeconds = countdownEndsAt === null
      ? null
      : Math.max(0, Math.ceil((countdownEndsAt - timestamp) / 1000));
    const elapsedSeconds = gameState === GAME_STATES.PLAYING && roundStartedAt !== null
      ? Math.max(0, Math.floor((timestamp - roundStartedAt) / 1000))
      : 0;

    return {
      gameState,
      arena: { width: ARENA.width, height: ARENA.height },
      players: playerSnapshot,
      meteors: meteors.map((meteor) => ({ ...meteor })),
      roundNumber,
      countdownSeconds,
      elapsedSeconds,
      winner: winner ? { ...winner } : null
    };
  }

  function broadcastState() {
    io.emit('gameState', createSnapshot());
  }

  function emitSocketError(socket, code, message) {
    log('warn', `payload rejeitado de ${socket.id}: ${code} (${message})`);
    socket.emit('serverError', { code, message });
  }

  function scheduleCountdownIfReady() {
    if (gameState !== GAME_STATES.WAITING) return;
    const enoughPlayers = Object.keys(players).length >= 2;
    if (enoughPlayers && countdownEndsAt === null) {
      countdownEndsAt = now() + COUNTDOWN_MS;
      log('info', `contagem regressiva iniciada: ${COUNTDOWN_MS / 1000}s`);
    } else if (!enoughPlayers) {
      countdownEndsAt = null;
    }
  }

  function movePlayer(player, input, dtSeconds) {
    const horizontal = Number(input.right) - Number(input.left);
    const vertical = Number(input.down) - Number(input.up);
    if (horizontal === 0 && vertical === 0) return player;
    const magnitude = Math.hypot(horizontal, vertical);
    player.x += (horizontal / magnitude) * PLAYER_SPEED * dtSeconds;
    player.y += (vertical / magnitude) * PLAYER_SPEED * dtSeconds;
    return clampPlayerToArena(player);
  }

  function getDifficulty(elapsedSeconds) {
    const level = Math.floor(Math.max(0, elapsedSeconds) / 10);
    return {
      level,
      spawnIntervalMs: Math.max(MIN_METEOR_INTERVAL_MS, BASE_METEOR_INTERVAL_MS - level * 105),
      speed: BASE_METEOR_SPEED + level * 24
    };
  }

  /** Cria um meteoro fora de uma borda, direcionado a um ponto dentro da arena. */
  function spawnMeteor() {
    const radius = Math.round(randomBetween(14, 29));
    const side = Math.floor(random() * 4);
    let x;
    let y;
    if (side === 0) { x = -radius; y = randomBetween(0, ARENA.height); }
    else if (side === 1) { x = ARENA.width + radius; y = randomBetween(0, ARENA.height); }
    else if (side === 2) { x = randomBetween(0, ARENA.width); y = -radius; }
    else { x = randomBetween(0, ARENA.width); y = ARENA.height + radius; }

    const targetX = randomBetween(0, ARENA.width);
    const targetY = randomBetween(0, ARENA.height);
    const dx = targetX - x;
    const dy = targetY - y;
    const distance = Math.hypot(dx, dy) || 1;
    const elapsed = roundStartedAt === null ? 0 : Math.max(0, (now() - roundStartedAt) / 1000);
    const difficulty = getDifficulty(elapsed);
    const speed = difficulty.speed + randomBetween(0, 36);
    const meteor = {
      id: nextMeteorId++,
      x,
      y,
      vx: (dx / distance) * speed,
      vy: (dy / distance) * speed,
      radius
    };
    meteors.push(meteor);
    return meteor;
  }

  function startRound() {
    if (Object.keys(players).length < 2) {
      countdownEndsAt = null;
      gameState = GAME_STATES.WAITING;
      return false;
    }
    gameState = GAME_STATES.PLAYING;
    roundNumber += 1;
    roundStartedAt = now();
    countdownEndsAt = null;
    roundEndsAt = null;
    winner = null;
    meteors.length = 0;
    roundParticipantIds = new Set(Object.keys(players));
    for (const [id, player] of Object.entries(players)) {
      Object.assign(player, randomPosition(player.radius), { alive: true, survivalTime: 0 });
      inputs[id] = { ...ZERO_INPUT };
    }
    spawnMeteor();
    nextMeteorAt = now() + getDifficulty(0).spawnIntervalMs;
    io.emit('roundStarted', { roundNumber });
    log('info', `rodada ${roundNumber} iniciada com ${roundParticipantIds.size} jogadores`);
    return true;
  }

  function finishRound(winnerId = null) {
    if (gameState !== GAME_STATES.PLAYING) return false;
    const winnerPlayer = winnerId && players[winnerId] && players[winnerId].alive
      ? players[winnerId]
      : null;
    winner = winnerPlayer ? { id: winnerPlayer.id, nickname: winnerPlayer.nickname } : null;
    if (winnerPlayer) winnerPlayer.wins += 1;
    gameState = GAME_STATES.ROUND_OVER;
    roundEndsAt = now() + ROUND_OVER_MS;
    countdownEndsAt = null;
    nextMeteorAt = null;
    log('info', winner ? `fim da rodada ${roundNumber}; vencedor: ${winner.nickname}` : `fim da rodada ${roundNumber}; sem sobrevivente`);
    io.emit('roundEnded', { roundNumber, winner: winner ? { ...winner } : null, durationMs: ROUND_OVER_MS });
    return true;
  }

  function evaluateRoundEnd() {
    if (gameState !== GAME_STATES.PLAYING) return false;
    const livingParticipants = [...roundParticipantIds]
      .map((id) => players[id])
      .filter((player) => player && player.alive === true);
    if (livingParticipants.length === 0) return finishRound(null);
    if (roundParticipantIds.size >= 2 && livingParticipants.length === 1) {
      return finishRound(livingParticipants[0].id);
    }
    return false;
  }

  function resetAfterRound() {
    gameState = GAME_STATES.WAITING;
    roundStartedAt = null;
    roundEndsAt = null;
    nextMeteorAt = null;
    winner = null;
    roundParticipantIds = new Set();
    meteors.length = 0;
    for (const [id, player] of Object.entries(players)) {
      Object.assign(player, randomPosition(player.radius), { alive: true, survivalTime: 0 });
      inputs[id] = { ...ZERO_INPUT };
    }
    scheduleCountdownIfReady();
    io.emit('roundReset', { roundNumber });
  }

  /** Um passo fixo de simulação. Também é exposto para testes determinísticos. */
  function tick() {
    const timestamp = now();

    if (gameState === GAME_STATES.WAITING) {
      scheduleCountdownIfReady();
      if (countdownEndsAt !== null && timestamp >= countdownEndsAt) startRound();
    } else if (gameState === GAME_STATES.PLAYING) {
      const dtSeconds = tickMs / 1000;
      const elapsedSeconds = roundStartedAt === null ? 0 : (timestamp - roundStartedAt) / 1000;
      const difficulty = getDifficulty(elapsedSeconds);

      for (const [id, player] of Object.entries(players)) {
        const input = inputs[id] || ZERO_INPUT;
        movePlayer(player, input, dtSeconds);
        if (roundParticipantIds.has(id) && player.alive) player.survivalTime += dtSeconds;
      }

      if (nextMeteorAt === null) nextMeteorAt = timestamp;
      if (timestamp >= nextMeteorAt) {
        spawnMeteor();
        nextMeteorAt = timestamp + difficulty.spawnIntervalMs;
      }

      for (let index = meteors.length - 1; index >= 0; index -= 1) {
        const meteor = meteors[index];
        meteor.x += meteor.vx * dtSeconds;
        meteor.y += meteor.vy * dtSeconds;
        if (
          meteor.x < -meteor.radius - 24 || meteor.x > ARENA.width + meteor.radius + 24 ||
          meteor.y < -meteor.radius - 24 || meteor.y > ARENA.height + meteor.radius + 24
        ) {
          meteors.splice(index, 1);
          continue;
        }
        for (const [id, player] of Object.entries(players)) {
          if (!roundParticipantIds.has(id) || !player.alive) continue;
          if (checkPlayerMeteorCollision(player, meteor)) {
            player.alive = false;
            io.emit('playerEliminated', { id, nickname: player.nickname });
            break;
          }
        }
      }
      evaluateRoundEnd();
    } else if (gameState === GAME_STATES.ROUND_OVER && roundEndsAt !== null && timestamp >= roundEndsAt) {
      resetAfterRound();
    }

    broadcastState();
  }

  io.engine.on('connection_error', (error) => {
    log('error', `falha de conexão Engine.IO (${error.code || 'sem código'}): ${error.message}`);
  });

  io.on('connection', (socket) => {
    log('info', `socket conectado: ${socket.id}`);
    socket.on('error', (error) => log('error', `erro no socket ${socket.id}`, error));
    socket.emit('gameState', createSnapshot());

    socket.on('joinGame', (payload) => {
      try {
        if (players[socket.id]) {
          emitSocketError(socket, 'ALREADY_JOINED', 'Você já está na arena.');
          return;
        }
        if (Object.keys(players).length >= MAX_PLAYERS) {
          emitSocketError(socket, 'ROOM_FULL', 'A sala atingiu o limite de jogadores.');
          return;
        }
        const validation = validateJoinPayload(payload, socket.id);
        if (!validation.ok) {
          emitSocketError(socket, validation.code, validation.message);
          return;
        }

        const position = randomPosition(PLAYER_RADIUS);
        const player = {
          id: socket.id,
          x: position.x,
          y: position.y,
          radius: PLAYER_RADIUS,
          color: COLORS[nextColor++ % COLORS.length],
          nickname: validation.value.nickname,
          character: validation.value.character,
          alive: gameState === GAME_STATES.WAITING,
          survivalTime: 0,
          wins: 0
        };
        players[socket.id] = player;
        inputs[socket.id] = { ...ZERO_INPUT };
        socket.data.hasJoined = true;

        scheduleCountdownIfReady();
        socket.emit('initState', { playerId: socket.id, ...createSnapshot() });
        socket.broadcast.emit('playerJoined', { ...player });
        log('info', `jogador entrou: ${player.nickname} (${player.character})`);
        broadcastState();
      } catch (error) {
        log('error', `falha ao processar joinGame de ${socket.id}`, error);
        emitSocketError(socket, 'JOIN_FAILED', 'Não foi possível entrar na arena. Tente novamente.');
      }
    });

    socket.on('playerInput', (payload) => {
      try {
        if (!players[socket.id]) {
          emitSocketError(socket, 'PLAYER_NOT_JOINED', 'Entre na arena antes de enviar controles.');
          return;
        }
        const input = validateInputPayload(payload);
        if (!input) {
          emitSocketError(socket, 'INVALID_INPUT', 'Controles inválidos. Envie up/down/left/right como booleanos.');
          return;
        }
        inputs[socket.id] = input;
      } catch (error) {
        log('error', `falha ao processar playerInput de ${socket.id}`, error);
        emitSocketError(socket, 'INPUT_FAILED', 'Não foi possível processar os controles.');
      }
    });

    socket.on('disconnect', (reason) => {
      try {
        const player = players[socket.id];
        if (!player) {
          log('info', `socket desconectado antes de entrar: ${socket.id} (${reason})`);
          delete inputs[socket.id];
          return;
        }
        delete players[socket.id];
        delete inputs[socket.id];
        socket.broadcast.emit('playerLeft', { id: socket.id, nickname: player.nickname });
        log('info', `jogador saiu: ${player.nickname} (${reason})`);
        evaluateRoundEnd();
        scheduleCountdownIfReady();
        broadcastState();
      } catch (error) {
        log('error', `falha ao remover jogador ${socket.id}`, error);
      }
    });
  });

  server.on('error', (error) => log('error', 'erro no servidor HTTP', error));

  function startTickLoop() {
    if (tickIntervalId !== null) return;
    tickIntervalId = setInterval(tick, tickMs);
    if (typeof tickIntervalId.unref === 'function') tickIntervalId.unref();
  }

  function stopTickLoop() {
    if (tickIntervalId !== null) {
      clearInterval(tickIntervalId);
      tickIntervalId = null;
    }
  }

  function listen(port = PORT, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(Number(port), host);
    });
  }

  function close() {
    stopTickLoop();
    return new Promise((resolve) => {
      io.close(() => resolve());
    });
  }

  return {
    app,
    server,
    io,
    players,
    meteors,
    get gameState() { return gameState; },
    get winner() { return winner ? { ...winner } : null; },
    get countdownEndsAt() { return countdownEndsAt; },
    get roundNumber() { return roundNumber; },
    getSnapshot: createSnapshot,
    movePlayer,
    spawnMeteor,
    startRound,
    finishRound,
    evaluateRoundEnd,
    tick,
    startTickLoop,
    stopTickLoop,
    listen,
    close
  };
}

const defaultRuntime = createGameServer();
if (require.main === module) {
  defaultRuntime.startTickLoop();
  defaultRuntime.listen(PORT, '0.0.0.0')
    .then((address) => console.log(`Desvie dos Meteoros rodando em http://localhost:${address.port}`))
    .catch((error) => {
      console.error('[FALHA AO INICIAR]', error);
      process.exitCode = 1;
    });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ENCERRANDO] Sinal ${signal}; fechando conexões e tick loop.`);
    defaultRuntime.close().catch((error) => {
      console.error('[FALHA AO ENCERRAR]', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const constants = {
  PORT,
  ARENA,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  TICK_RATE,
  TICK_MS,
  COUNTDOWN_MS,
  ROUND_OVER_MS,
  MAX_NICKNAME_LENGTH,
  MAX_PLAYERS,
  CHARACTERS,
  DEFAULT_CHARACTER,
  GAME_STATES,
  BASE_METEOR_INTERVAL_MS,
  MIN_METEOR_INTERVAL_MS,
  BASE_METEOR_SPEED
};

module.exports = {
  createGameServer,
  validateJoinPayload,
  validateInputPayload,
  clamp,
  clampPlayerToArena,
  checkPlayerMeteorCollision,
  getDifficulty: (elapsedSeconds) => {
    const level = Math.floor(Math.max(0, elapsedSeconds) / 10);
    return {
      level,
      spawnIntervalMs: Math.max(MIN_METEOR_INTERVAL_MS, BASE_METEOR_INTERVAL_MS - level * 105),
      speed: BASE_METEOR_SPEED + level * 24
    };
  },
  constants,
  get app() { return defaultRuntime.app; },
  get server() { return defaultRuntime.server; },
  get io() { return defaultRuntime.io; },
  get players() { return defaultRuntime.players; },
  get meteors() { return defaultRuntime.meteors; },
  get gameState() { return defaultRuntime.gameState; },
  get winner() { return defaultRuntime.winner; },
  getSnapshot: (...args) => defaultRuntime.getSnapshot(...args),
  movePlayer: (...args) => defaultRuntime.movePlayer(...args),
  spawnMeteor: (...args) => defaultRuntime.spawnMeteor(...args),
  startRound: (...args) => defaultRuntime.startRound(...args),
  finishRound: (...args) => defaultRuntime.finishRound(...args),
  evaluateRoundEnd: (...args) => defaultRuntime.evaluateRoundEnd(...args),
  tick: (...args) => defaultRuntime.tick(...args),
  startTickLoop: (...args) => defaultRuntime.startTickLoop(...args),
  stopTickLoop: (...args) => defaultRuntime.stopTickLoop(...args),
  listen: (...args) => defaultRuntime.listen(...args),
  close: (...args) => defaultRuntime.close(...args)
};
