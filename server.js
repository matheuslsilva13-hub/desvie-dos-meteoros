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
  },
