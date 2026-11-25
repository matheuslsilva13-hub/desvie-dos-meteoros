'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 25000,
  transports: ['websocket', 'polling']
});

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;

// Física e mobilidade sincronizadas com o client.js
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 290;
const DASH_SPEED = 680;
const DASH_DURATION = 0.16;
const DASH_COOLDOWN = 2.4;

// Configuração dos itens colecionáveis
const POWERUP_RADIUS = 14;
const POWERUP_SPAWN_INTERVAL = 6.5; // segundos entre cada item
const POWERUP_LIFETIME = 11;        // segundos antes de desaparecer
const MAX_POWERUPS = 3;

const GAME_STATES = {
  WAITING: 'AGUARDANDO',
  PLAYING: 'EM_JOGO',
  ROUND_OVER: 'FIM_DE_RODADA'
};

const VALID_CHARACTERS = new Set(['nova', 'comet', 'pulse']);
const SHIP_COLORS = ['#63e4ff', '#ff7b54', '#a78bfa', '#34d399', '#fbbf24', '#f472b6'];

app.use(express.static(PUBLIC_DIR));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

let gameState = GAME_STATES.WAITING;
let roundNumber = 0;
let countdownTimer = null;
let countdownSeconds = null;
let roundOverTimer = null;
let elapsedSeconds = 0;
let spawnAccumulator = 0;
let powerupTimer = 0;
let nextMeteorId = 1;
let nextPowerupId = 1;
let winnerInfo = null;

const players = new Map();
let meteors = [];
let powerups = [];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return Array.from(cleaned).slice(0, 16).join('');
}

function randomSpawnPosition(margin = 70) {
  return {
    x: margin + Math.random() * (ARENA_WIDTH - margin * 2),
    y: margin + Math.random() * (ARENA_HEIGHT - margin * 2)
  };
}

function serializePlayers() {
  const out = {};
  for (const [id, p] of players.entries()) {
    out[id] = {
      id: p.id,
      nickname: p.nickname,
      character: p.character,
      color: p.color,
      x: Number(p.x.toFixed(2)),
      y: Number(p.y.toFixed(2)),
      radius: p.radius,
      speed: PLAYER_SPEED,
      alive: p.alive,
      shield: p.shield,
      dashCooldown: Number(Math.max(0, p.dashCooldownTimer).toFixed(2)),
      isDashing: p.dashActiveTimer > 0,
      survivalTime: Number(p.survivalTime.toFixed(1)),
      wins: p.wins
    };
  }
  return out;
}

function buildSnapshot() {
  return {
    gameState,
    roundNumber,
    countdownSeconds,
    elapsedSeconds: Math.floor(elapsedSeconds),
    playerSpeed: PLAYER_SPEED,
    dashSpeed: DASH_SPEED,
    dashDuration: DASH_DURATION,
    dashCooldownMax: DASH_COOLDOWN,
    winner: winnerInfo,
    players: serializePlayers(),
    meteors: meteors.map((m) => ({
      id: m.id,
      x: Number(m.x.toFixed(1)),
      y: Number(m.y.toFixed(1)),
      vx: Number(m.vx.toFixed(1)),
      vy: Number(m.vy.toFixed(1)),
      radius: m.radius
    })),
    powerups: powerups.map((pu) => ({
      id: pu.id,
      type: pu.type,
      x: Number(pu.x.toFixed(1)),
      y: Number(pu.y.toFixed(1)),
      radius: pu.radius,
      ttl: Number(pu.ttl.toFixed(1))
    }))
  };
}

function clearTimers() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (roundOverTimer) {
    clearTimeout(roundOverTimer);
    roundOverTimer = null;
  }
  countdownSeconds = null;
}

function startCountdown(seconds = 3) {
  if (countdownTimer || gameState === GAME_STATES.PLAYING) return;
  clearTimers();
  gameState = GAME_STATES.WAITING;
  countdownSeconds = seconds;

  countdownTimer = setInterval(() => {
    if (players.size === 0) {
      clearTimers();
      return;
    }
    countdownSeconds -= 1;
    if (countdownSeconds <= 0) {
      clearTimers();
      startRound();
    }
  }, 1000);
}

function startRound() {
  clearTimers();
  roundNumber += 1;
  gameState = GAME_STATES.PLAYING;
  elapsedSeconds = 0;
  spawnAccumulator = 0;
  powerupTimer = 2.5; // primeiro item aparece após 4s
  meteors = [];
  powerups = [];
  winnerInfo = null;

  for (const p of players.values()) {
    const pos = randomSpawnPosition();
    p.x = pos.x;
    p.y = pos.y;
    p.alive = true;
    p.shield = true;
    p.survivalTime = 0;
    p.dashActiveTimer = 0;
    p.dashCooldownTimer = 0;
    p.dashDir = { x: 0, y: -1 };
  }
}

function endRound(winner) {
  if (gameState !== GAME_STATES.PLAYING) return;
  gameState = GAME_STATES.ROUND_OVER;
  winnerInfo = winner ? { id: winner.id, nickname: winner.nickname } : null;
  if (winner) {
    winner.wins += 1;
  }

  io.emit('roundEnded', { winner: winnerInfo });

  roundOverTimer = setTimeout(() => {
    roundOverTimer = null;
    if (players.size >= 1) {
      startCountdown(3);
    } else {
      gameState = GAME_STATES.WAITING;
      meteors = [];
      powerups = [];
      winnerInfo = null;
    }
  }, 3500);
}

function spawnPowerup() {
  if (powerups.length >= MAX_POWERUPS) return;
  const pos = randomSpawnPosition(65);
  // 55% chance de Escudo, 45% chance de Estrela (+10s de pontuação)
  const type = Math.random() < 0.55 ? 'shield' : 'points';
  powerups.push({
    id: nextPowerupId++,
    type,
    x: pos.x,
    y: pos.y,
    radius: POWERUP_RADIUS,
    ttl: POWERUP_LIFETIME
  });
}

function spawnMeteor() {
  const difficulty = Math.min(2.6, 1 + elapsedSeconds * 0.025);
  const radius = Math.round(13 + Math.random() * 19);
  const baseSpeed = (145 + Math.random() * 130) * difficulty;

  const side = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (side === 0) {
    x = Math.random() * ARENA_WIDTH;
    y = -radius - 10;
  } else if (side === 1) {
    x = ARENA_WIDTH + radius + 10;
    y = Math.random() * ARENA_HEIGHT;
  } else if (side === 2) {
    x = Math.random() * ARENA_WIDTH;
    y = ARENA_HEIGHT + radius + 10;
  } else {
    x = -radius - 10;
    y = Math.random() * ARENA_HEIGHT;
  }

  const aliveList = Array.from(players.values()).filter((p) => p.alive);
  let targetX = ARENA_WIDTH * (0.2 + Math.random() * 0.6);
  let targetY = ARENA_HEIGHT * (0.2 + Math.random() * 0.6);

  if (aliveList.length > 0 && Math.random() < 0.65) {
    const targetPlayer = aliveList[Math.floor(Math.random() * aliveList.length)];
    targetX = targetPlayer.x + (Math.random() - 0.5) * 140;
    targetY = targetPlayer.y + (Math.random() - 0.5) * 140;
  }

  const angle = Math.atan2(targetY - y, targetX - x);
  meteors.push({
    id: nextMeteorId++,
    x,
    y,
    vx: Math.cos(angle) * baseSpeed,
    vy: Math.sin(angle) * baseSpeed,
    radius
  });
}

function triggerDash(player) {
  if (!player || !player.alive || gameState !== GAME_STATES.PLAYING) return;
  if (player.dashCooldownTimer > 0 || player.dashActiveTimer > 0) return;

  let dx = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
  let dy = (player.input.down ? 1 : 0) - (player.input.up ? 1 : 0);
  if (dx === 0 && dy === 0) {
    dx = player.lastDir.x;
    dy = player.lastDir.y;
  }
  const len = Math.hypot(dx, dy) || 1;
  player.dashDir = { x: dx / len, y: dy / len };
  player.dashActiveTimer = DASH_DURATION;
  player.dashCooldownTimer = DASH_COOLDOWN;
}

function stepSimulation(dt) {
  if (players.size === 0) return;

  for (const p of players.values()) {
    if (p.dashCooldownTimer > 0) p.dashCooldownTimer = Math.max(0, p.dashCooldownTimer - dt);
    if (p.dashActiveTimer > 0) p.dashActiveTimer = Math.max(0, p.dashActiveTimer - dt);

    let vx = 0;
    let vy = 0;

    if (p.dashActiveTimer > 0) {
      vx = p.dashDir.x * DASH_SPEED;
      vy = p.dashDir.y * DASH_SPEED;
    } else {
      let ix = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let iy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (ix !== 0 || iy !== 0) {
        const len = Math.hypot(ix, iy);
        ix /= len;
        iy /= len;
        p.lastDir = { x: ix, y: iy };
        vx = ix * PLAYER_SPEED;
        vy = iy * PLAYER_SPEED;
      }
    }

    p.x = clamp(p.x + vx * dt, p.radius, ARENA_WIDTH - p.radius);
    p.y = clamp(p.y + vy * dt, p.radius, ARENA_HEIGHT - p.radius);
  }

  if (gameState !== GAME_STATES.PLAYING) return;

  elapsedSeconds += dt;
  const spawnRate = Math.min(9.5, 2.2 + elapsedSeconds * 0.14);
  spawnAccumulator += dt * spawnRate;
  while (spawnAccumulator >= 1) {
    spawnAccumulator -= 1;
    spawnMeteor();
  }

  // Geração e tempo de vida dos itens colecionáveis
  powerupTimer += dt;
  if (powerupTimer >= POWERUP_SPAWN_INTERVAL) {
    powerupTimer = 0;
    spawnPowerup();
  }
  powerups = powerups.filter((pu) => {
    pu.ttl -= dt;
    return pu.ttl > 0;
  });

  const margin = 120;
  meteors = meteors.filter((m) => {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    return (
      m.x >= -margin &&
      m.x <= ARENA_WIDTH + margin &&
      m.y >= -margin &&
      m.y <= ARENA_HEIGHT + margin
    );
  });

  const startingCount = players.size;
  for (const p of players.values()) {
    if (!p.alive) continue;
    p.survivalTime += dt;

    // Coleta de Power-ups (funciona mesmo durante o dash)
    for (let i = powerups.length - 1; i >= 0; i -= 1) {
      const pu = powerups[i];
      const dist = Math.hypot(p.x - pu.x, p.y - pu.y);
      if (dist < p.radius + pu.radius + 4) {
        powerups.splice(i, 1);
        let rewardText = '';
        if (pu.type === 'shield') {
          if (!p.shield) {
            p.shield = true;
            rewardText = 'Escudo de energia restaurado!';
          } else {
            p.survivalTime += 5;
            rewardText = 'Escudo cheio! Bônus de +5s!';
          }
        } else {
          p.survivalTime += 10;
          rewardText = 'Estrela coletada! +10s de pontuação!';
        }
        io.to(p.id).emit('powerupCollected', { type: pu.type, message: rewardText });
      }
    }

    if (p.dashActiveTimer > 0) continue;

    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      const m = meteors[i];
      const dist = Math.hypot(p.x - m.x, p.y - m.y);
      const hitDist = (p.radius * 0.78) + (m.radius * 0.85);
      if (dist < hitDist) {
        meteors.splice(i, 1);
        if (p.shield) {
          p.shield = false;
          io.to(p.id).emit('shieldBroken');
        } else {
          p.alive = false;
          io.emit('playerEliminated', { id: p.id, nickname: p.nickname });
        }
        break;
      }
    }
  }

  const alivePlayers = Array.from(players.values()).filter((p) => p.alive);
  if (startingCount === 1 && alivePlayers.length === 0) {
    endRound(null);
  } else if (startingCount >= 2 && alivePlayers.length <= 1) {
    endRound(alivePlayers[0] || null);
  }
}

io.on('connection', (socket) => {
  socket.on('joinGame', (payload = {}) => {
    if (players.has(socket.id)) return;

    const nickname = sanitizeNickname(payload.nickname);
    if (!nickname) {
      socket.emit('serverError', { message: 'Digite um codinome válido (1 a 16 caracteres).' });
      return;
    }

    const character = VALID_CHARACTERS.has(payload.character) ? payload.character : 'nova';
    const color = SHIP_COLORS[players.size % SHIP_COLORS.length];
    const pos = randomSpawnPosition();

    const player = {
      id: socket.id,
      nickname,
      character,
      color,
      x: pos.x,
      y: pos.y,
      radius: PLAYER_RADIUS,
      alive: gameState === GAME_STATES.WAITING,
      shield: true,
      survivalTime: 0,
      wins: 0,
      input: { up: false, down: false, left: false, right: false },
      lastDir: { x: 0, y: -1 },
      dashActiveTimer: 0,
      dashCooldownTimer: 0,
      dashDir: { x: 0, y: -1 }
    };

    players.set(socket.id, player);

    socket.emit('initState', {
      playerId: socket.id,
      ...buildSnapshot()
    });

    socket.broadcast.emit('playerJoined', {
      id: player.id,
      nickname: player.nickname
    });

    if (gameState === GAME_STATES.WAITING && !countdownTimer) {
      startCountdown(3);
    }
  });

  socket.on('playerInput', (input = {}) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.input = {
      up: Boolean(input.up),
      down: Boolean(input.down),
      left: Boolean(input.left),
      right: Boolean(input.right)
    };
    if (input.dash) {
      triggerDash(p);
    }
  });

  socket.on('playerDash', () => {
    const p = players.get(socket.id);
    if (p) triggerDash(p);
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    players.delete(socket.id);
    io.emit('playerLeft', { id: p.id, nickname: p.nickname });

    if (players.size === 0) {
      clearTimers();
      gameState = GAME_STATES.WAITING;
      meteors = [];
      powerups = [];
      winnerInfo = null;
    }
  });
});

setInterval(() => {
  stepSimulation(TICK_DT);
  if (players.size > 0) {
    io.emit('gameState', buildSnapshot());
  }
}, 1000 / TICK_RATE);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Desvie dos Meteoros rodando em http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
