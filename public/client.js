'use strict';

// Cliente com Predição Local (zero delay nas teclas) e Interpolação Suave.
const socket = io({
  transports: ['websocket'],
  upgrade: false
});

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const joinOverlay = document.getElementById('joinOverlay');
const joinForm = document.getElementById('joinForm');
const nicknameInput = document.getElementById('nicknameInput');
const joinButton = document.getElementById('joinButton');
const formError = document.getElementById('formError');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const gameBanner = document.getElementById('gameBanner');
const bannerText = document.getElementById('bannerText');
const leaderboard = document.getElementById('leaderboard');
const playerCount = document.getElementById('playerCount');
const meteorCount = document.getElementById('meteorCount');
const aliveCount = document.getElementById('aliveCount');
const roundNumber = document.getElementById('roundNumber');
const roundStatus = document.getElementById('roundStatus');
const roundHint = document.getElementById('roundHint');
const roundStatusDot = document.getElementById('roundStatusDot');
const eventFeed = document.getElementById('eventFeed');

const ASSETS = {
  map: '/assets/arena-nebula.png',
  characters: {
    nova: '/assets/ship-nova.png',
    comet: '/assets/ship-comet.png',
    pulse: '/assets/ship-pulse.png'
  }
};

// Velocidade padrão em pixels/segundo (será sobrescrita se o server.js enviar playerSpeed no initState)
let localPlayerSpeed = 240;

const GAME_STATES = { WAITING: 'AGUARDANDO', PLAYING: 'EM_JOGO', ROUND_OVER: 'FIM_DE_RODADA' };
const KEY_TO_DIRECTION = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right'
};

const mapImage = new Image();
mapImage.src = ASSETS.map;
const characterImages = {};
for (const [name, src] of Object.entries(ASSETS.characters)) {
  const image = new Image();
  image.src = src;
  characterImages[name] = image;
}

// Pré-renderiza o fundo uma única vez em um canvas auxiliar
const bgCanvas = document.createElement('canvas');
bgCanvas.width = canvas.width;
bgCanvas.height = canvas.height;
const bgCtx = bgCanvas.getContext('2d');
let bgCached = false;

function rebuildBackgroundCache() {
  bgCtx.fillStyle = '#090b18';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  if (mapImage.complete && mapImage.naturalWidth > 0) {
    const scale = Math.max(bgCanvas.width / mapImage.naturalWidth, bgCanvas.height / mapImage.naturalHeight);
    const sourceWidth = bgCanvas.width / scale;
    const sourceHeight = bgCanvas.height / scale;
    const sourceX = (mapImage.naturalWidth - sourceWidth) / 2;
    const sourceY = (mapImage.naturalHeight - sourceHeight) / 2;
    bgCtx.drawImage(mapImage, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, bgCanvas.width, bgCanvas.height);
    bgCached = true;
  }
  const shade = bgCtx.createLinearGradient(0, 0, 0, bgCanvas.height);
  shade.addColorStop(0, 'rgba(5, 8, 22, .26)');
  shade.addColorStop(1, 'rgba(5, 7, 18, .49)');
  bgCtx.fillStyle = shade;
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  bgCtx.strokeStyle = 'rgba(168, 186, 255, .16)';
  bgCtx.lineWidth = 2;
  bgCtx.strokeRect(1, 1, bgCanvas.width - 2, bgCanvas.height - 2);
}

mapImage.onload = rebuildBackgroundCache;
rebuildBackgroundCache();

let myPlayerId = null;
let hasJoined = false;
let hasEnteredSession = false;
let joinPending = false;
let savedJoinPayload = null;
let currentState = {
  gameState: GAME_STATES.WAITING,
  players: {},
  meteors: [],
  roundNumber: 0,
  countdownSeconds: null,
  elapsedSeconds: 0,
  winner: null
};

// Estado local predito para eliminar atraso de teclado e engasgos de rede
let predictedSelf = null;
const visualPlayers = new Map();
const meteorShapes = new Map();

let feedTimer = null;
let hudUpdateScheduled = false;
const heldKeys = new Set();
let lastInputSignature = '';
let lastFrameTime = performance.now();
let lastSnapshotTime = performance.now();

function showEvent(message, isError = false) {
  eventFeed.textContent = message;
  eventFeed.classList.toggle('is-error', isError);
  eventFeed.classList.add('visible');
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => eventFeed.classList.remove('visible'), 2700);
}

function updateConnection(state, label) {
  connectionStatus.classList.remove('connected', 'disconnected');
  if (state) connectionStatus.classList.add(state);
  statusText.textContent = label;
}

function currentInput() {
  let up = false, down = false, left = false, right = false;
  for (const code of heldKeys) {
    const dir = KEY_TO_DIRECTION[code];
    if (dir === 'up') up = true;
    else if (dir === 'down') down = true;
    else if (dir === 'left') left = true;
    else if (dir === 'right') right = true;
  }
  return { up, down, left, right };
}

function sendInput(force = false) {
  if (!hasJoined || !socket.connected) return;
  const input = currentInput();
  const signature = `${input.up ? 1 : 0}${input.down ? 1 : 0}${input.left ? 1 : 0}${input.right ? 1 : 0}`;
  if (force || signature !== lastInputSignature) {
    socket.emit('playerInput', input);
    lastInputSignature = signature;
  }
}

function emitJoin() {
  if (!savedJoinPayload || !socket.connected || joinPending) return;
  joinPending = true;
  joinButton.disabled = true;
  joinButton.querySelector('span').textContent = 'CONECTANDO...';
  formError.textContent = '';
  socket.emit('joinGame', savedJoinPayload);
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (joinPending || hasJoined) return;
  const nickname = nicknameInput.value.trim();
  const nicknameLength = Array.from(nickname).length;
  if (!nickname || nicknameLength > 16 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
    formError.textContent = 'Digite um codinome válido, de 1 a 16 caracteres.';
    nicknameInput.focus();
    return;
  }
  const selected = joinForm.querySelector('input[name="character"]:checked');
  savedJoinPayload = { nickname, character: selected ? selected.value : 'nova' };
  hasEnteredSession = true;
  emitJoin();
});

window.addEventListener('keydown', (event) => {
  if (!hasJoined || !KEY_TO_DIRECTION[event.code]) return;
  event.preventDefault();
  if (!event.repeat && !heldKeys.has(event.code)) {
    heldKeys.add(event.code);
    sendInput();
  }
});

window.addEventListener('keyup', (event) => {
  if (!KEY_TO_DIRECTION[event.code]) return;
  event.preventDefault();
  if (heldKeys.delete(event.code)) {
    sendInput();
  }
});

window.addEventListener('blur', () => {
  if (heldKeys.size > 0) {
    heldKeys.clear();
    sendInput(true);
  }
});

socket.on('connect', () => {
  updateConnection('connected', 'Conectado');
  if (hasEnteredSession && !hasJoined && savedJoinPayload) emitJoin();
});

socket.on('disconnect', () => {
  updateConnection('disconnected', 'Reconectando...');
  hasJoined = false;
  joinPending = false;
  predictedSelf = null;
  heldKeys.clear();
  lastInputSignature = '';
  joinButton.disabled = false;
  joinButton.querySelector('span').textContent = 'LANÇAR NAVE';
  showEvent('Conexão interrompida. Tentando reconectar...', true);
});

socket.on('connect_error', (error) => {
  console.error('[Socket.io] Falha ao conectar:', error.message);
  updateConnection('disconnected', 'Falha de conexão');
});

socket.on('serverError', (error) => {
  joinPending = false;
  joinButton.disabled = false;
  joinButton.querySelector('span').textContent = 'LANÇAR NAVE';
  if (!hasJoined) {
    hasEnteredSession = false;
    formError.textContent = error && error.message ? error.message : 'Não foi possível entrar. Tente novamente.';
  } else {
    showEvent(error && error.message ? error.message : 'Entrada rejeitada pelo servidor.', true);
  }
});

socket.on('initState', (payload) => {
  myPlayerId = payload.playerId;
  hasJoined = true;
  joinPending = false;
  currentState = payload;
  lastSnapshotTime = performance.now();

  if (typeof payload.playerSpeed === 'number' && payload.playerSpeed > 0) {
    localPlayerSpeed = payload.playerSpeed;
  }

  const me = payload.players && payload.players[myPlayerId];
  if (me) {
    if (typeof me.speed === 'number' && me.speed > 0) {
      localPlayerSpeed = me.speed;
    }
    predictedSelf = { x: me.x, y: me.y };
  }

  joinOverlay.classList.add('hidden');
  joinButton.disabled = false;
  joinButton.querySelector('span').textContent = 'LANÇAR NAVE';
  lastInputSignature = '';
  sendInput(true);
  updateHud();
});

socket.on('gameState', (snapshot) => {
  currentState = snapshot;
  lastSnapshotTime = performance.now();

  // Reconciliação suave com margem de tolerância para evitar puxões por latência
  const serverMe = snapshot.players && snapshot.players[myPlayerId];
  if (serverMe) {
    if (typeof serverMe.speed === 'number' && serverMe.speed > 0) {
      localPlayerSpeed = serverMe.speed;
    }
    if (!predictedSelf || snapshot.gameState !== GAME_STATES.PLAYING) {
      predictedSelf = { x: serverMe.x, y: serverMe.y };
    } else {
      const dx = serverMe.x - predictedSelf.x;
      const dy = serverMe.y - predictedSelf.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 110) {
        // Teleporte ou início de rodada: sincroniza imediatamente
        predictedSelf.x = serverMe.x;
        predictedSelf.y = serverMe.y;
      } else if (dist > 10) {
        // Correção gradual apenas quando a divergência ultrapassar a margem de latência
        predictedSelf.x += dx * 0.08;
        predictedSelf.y += dy * 0.08;
      }
    }
  }

  scheduleHudUpdate();
});

socket.on('playerJoined', (player) => {
  showEvent(`${player.nickname} entrou na arena.`);
});

socket.on('playerLeft', (player) => {
  visualPlayers.delete(player.id);
  showEvent(`${player.nickname} deixou a arena.`);
});

socket.on('playerEliminated', (player) => {
  showEvent(`${player.nickname} foi atingido e agora observa como fantasma.`);
});

socket.on('roundEnded', ({ winner }) => {
  showEvent(winner ? `${winner.nickname} venceu a rodada!` : 'A rodada terminou sem sobreviventes.');
});

function formatSeconds(seconds) {
  return `${Math.max(0, Number(seconds) || 0).toFixed(1)}s`;
}

// Atualiza o DOM apenas a 4 Hz para não travar a thread de renderização
function scheduleHudUpdate() {
  if (hudUpdateScheduled) return;
  hudUpdateScheduled = true;
  setTimeout(() => {
    hudUpdateScheduled = false;
    updateHud();
  }, 250);
}

function setBanner(text, stateClass) {
  if (bannerText.textContent !== text) bannerText.textContent = text;
  gameBanner.classList.remove('playing', 'finished');
  if (stateClass) gameBanner.classList.add(stateClass);
}

function updateHud() {
  const players = Object.values(currentState.players || {});
  const alive = players.filter((player) => player.alive === true).length;
  playerCount.textContent = String(players.length);
  meteorCount.textContent = String((currentState.meteors || []).length);
  aliveCount.textContent = `${alive} vivo${alive === 1 ? '' : 's'}`;
  roundNumber.textContent = `RODADA ${String(currentState.roundNumber || 0).padStart(2, '0')}`;

  switch (currentState.gameState) {
    case GAME_STATES.PLAYING:
      setBanner(`Tempo: ${currentState.elapsedSeconds || 0}s`, 'playing');
      roundStatus.textContent = 'Desvie dos meteoros';
      roundHint.textContent = `${alive} piloto${alive === 1 ? '' : 's'} ainda sobrevive${alive === 1 ? '' : 'm'}`;
      roundStatusDot.className = 'round-status-dot playing';
      break;
    case GAME_STATES.ROUND_OVER: {
      const winnerName = currentState.winner ? currentState.winner.nickname : 'Nenhum sobrevivente';
      setBanner(`Fim de Rodada! Vencedor: ${winnerName}`, 'finished');
      roundStatus.textContent = 'Fim de rodada';
      roundHint.textContent = currentState.winner ? `Vencedor: ${winnerName}` : 'Todos foram atingidos';
      roundStatusDot.className = 'round-status-dot finished';
      break;
    }
    default:
      if (currentState.countdownSeconds !== null && currentState.countdownSeconds !== undefined) {
        setBanner(`Tempo: ${currentState.countdownSeconds}s`, '');
        roundStatus.textContent = `Lançamento em ${currentState.countdownSeconds}s`;
        roundHint.textContent = 'Prepare-se para a chuva de meteoros';
      } else {
        setBanner('Aguardando jogadores...', '');
        roundStatus.textContent = 'Sala de espera';
        roundHint.textContent = players.length < 2 ? 'A partida começa com 2 pilotos' : 'Preparando a próxima rodada';
      }
      roundStatusDot.className = 'round-status-dot';
  }
  renderLeaderboard(players);
}

function renderLeaderboard(players) {
  const ordered = [...players].sort((a, b) => {
    if (a.alive !== b.alive) return Number(b.alive) - Number(a.alive);
    if (b.survivalTime !== a.survivalTime) return b.survivalTime - a.survivalTime;
    return a.nickname.localeCompare(b.nickname, 'pt-BR');
  });
  leaderboard.replaceChildren();
  if (ordered.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'empty-state';
    cell.textContent = 'Aguardando pilotos...';
    row.append(cell);
    leaderboard.append(row);
    return;
  }

  for (const player of ordered) {
    const row = document.createElement('tr');
    const pilotCell = document.createElement('td');
    const pilot = document.createElement('div');
    pilot.className = 'pilot-cell';
    const avatar = document.createElement('img');
    avatar.className = 'pilot-avatar';
    avatar.src = ASSETS.characters[player.character] || ASSETS.characters.nova;
    avatar.alt = '';
    avatar.style.setProperty('--avatar-color', player.color || '#63e4ff');
    const name = document.createElement('span');
    name.className = 'pilot-name';
    if (player.id === myPlayerId) name.classList.add('is-self');
    name.textContent = player.nickname;
    pilot.append(avatar, name);
    pilotCell.append(pilot);

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = player.alive ? 'status-label' : 'status-label ghost';
    status.textContent = player.alive ? 'Vivo' : 'Fantasma';
    statusCell.append(status);

    const timeCell = document.createElement('td');
    timeCell.className = 'time-cell';
    timeCell.textContent = formatSeconds(player.survivalTime);

    const winsCell = document.createElement('td');
    winsCell.className = 'wins-cell';
    winsCell.textContent = String(player.wins || 0);
    row.append(pilotCell, statusCell, timeCell, winsCell);
    leaderboard.append(row);
  }
}

function seededRandom(seed) {
  const value = Math.sin(seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// Cacheia a geometria do meteoro para não recalcular seno/cosseno a cada quadro
function getMeteorOffsets(meteor) {
  const key = `${meteor.id}_${meteor.radius}`;
  let offsets = meteorShapes.get(key);
  if (!offsets) {
    const seed = Number(meteor.id) || 1;
    const points = 10;
    offsets = [];
    for (let i = 0; i < points; i += 1) {
      const angle = (i / points) * Math.PI * 2;
      const jitter = 0.76 + seededRandom(seed * 13 + i) * 0.3;
      offsets.push([Math.cos(angle) * meteor.radius * jitter, Math.sin(angle) * meteor.radius * jitter]);
    }
    if (meteorShapes.size > 200) meteorShapes.clear();
    meteorShapes.set(key, offsets);
  }
  return offsets;
}

function drawMeteor(meteor, extrapSeconds) {
  // Extrapola a posição do meteoro usando sua velocidade para fluidez a 60/144 FPS
  const x = meteor.x + (meteor.vx || 0) * extrapSeconds;
  const y = meteor.y + (meteor.vy || 0) * extrapSeconds;

  const magnitude = Math.hypot(meteor.vx, meteor.vy) || 1;
  const trailLength = meteor.radius * 3.5;
  const tailX = x - (meteor.vx / magnitude) * trailLength;
  const tailY = y - (meteor.vy / magnitude) * trailLength;

  ctx.save();
  ctx.lineCap = 'round';
  const trail = ctx.createLinearGradient(tailX, tailY, x, y);
  trail.addColorStop(0, 'rgba(255, 85, 44, 0)');
  trail.addColorStop(0.58, 'rgba(255, 117, 56, .22)');
  trail.addColorStop(1, 'rgba(255, 214, 145, .85)');
  ctx.strokeStyle = trail;
  ctx.lineWidth = Math.max(5, meteor.radius * 0.68);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(x, y);
  ctx.stroke();

  const offsets = getMeteorOffsets(meteor);
  ctx.beginPath();
  for (let i = 0; i < offsets.length; i += 1) {
    const [dx, dy] = offsets[i];
    if (i === 0) ctx.moveTo(x + dx, y + dy);
    else ctx.lineTo(x + dx, y + dy);
  }
  ctx.closePath();
  ctx.fillStyle = '#c95d38';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 200, 140, .75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = 'rgba(77, 43, 48, .62)';
  ctx.beginPath();
  ctx.arc(x + meteor.radius * 0.23, y - meteor.radius * 0.16, meteor.radius * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(player, renderX, renderY) {
  const ghost = player.alive !== true;
  const radius = player.radius || 20;
  const sprite = characterImages[player.character] || characterImages.nova;
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.35;

  ctx.strokeStyle = player.color || '#63e4ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(renderX, renderY, radius + 2, 0, Math.PI * 2);
  ctx.stroke();

  if (player.id === myPlayerId) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.beginPath();
    ctx.arc(renderX, renderY, radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (sprite.complete && sprite.naturalWidth > 0) {
    const size = radius * 2.25;
    ctx.drawImage(sprite, renderX - size / 2, renderY - size / 2, size, size);
  } else {
    ctx.fillStyle = player.color || '#63e4ff';
    ctx.beginPath();
    ctx.arc(renderX, renderY, radius * 0.72, 0, Math.PI * 2);
    ctx.fill();
  }

  const label = ghost ? `${player.nickname} [Fantasma]` : player.nickname;
  const labelY = renderY - radius - 10;
  ctx.font = '700 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(4, 7, 18, .92)';
  ctx.strokeText(label, renderX, labelY);
  ctx.fillStyle = player.id === myPlayerId ? '#ffffff' : '#e8edff';
  ctx.fillText(label, renderX, labelY);
  ctx.restore();
}

function stepLocalPrediction(dt) {
  if (!hasJoined || !myPlayerId || !predictedSelf) return;
  const me = currentState.players && currentState.players[myPlayerId];
  if (!me || currentState.gameState !== GAME_STATES.PLAYING) return;

  const input = currentInput();
  let vx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let vy = (input.down ? 1 : 0) - (input.up ? 1 : 0);

  if (vx !== 0 || vy !== 0) {
    const len = Math.hypot(vx, vy);
    vx = (vx / len) * localPlayerSpeed;
    vy = (vy / len) * localPlayerSpeed;
    const r = me.radius || 20;
    predictedSelf.x = Math.max(r, Math.min(canvas.width - r, predictedSelf.x + vx * dt));
    predictedSelf.y = Math.max(r, Math.min(canvas.height - r, predictedSelf.y + vy * dt));
  }
}

function render(now) {
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (!bgCached && mapImage.complete && mapImage.naturalWidth > 0) {
    rebuildBackgroundCache();
  }

  stepLocalPrediction(dt);

  // Desenha o fundo pré-renderizado
  ctx.drawImage(bgCanvas, 0, 0);

  // Extrapolação limitada a 50 ms para evitar que meteoros atravessem a nave visualmente
  const extrapSeconds = Math.min(0.05, Math.max(0, (now - lastSnapshotTime) / 1000));
  for (const meteor of currentState.meteors || []) {
    drawMeteor(meteor, extrapSeconds);
  }

  for (const player of Object.values(currentState.players || {})) {
    if (player.id === myPlayerId && predictedSelf && currentState.gameState === GAME_STATES.PLAYING) {
      drawPlayer(player, predictedSelf.x, predictedSelf.y);
    } else {
      let vis = visualPlayers.get(player.id);
      if (!vis) {
        vis = { x: player.x, y: player.y };
        visualPlayers.set(player.id, vis);
      } else {
        vis.x += (player.x - vis.x) * 0.35;
        vis.y += (player.y - vis.y) * 0.35;
      }
      drawPlayer(player, vis.x, vis.y);
    }
  }

  requestAnimationFrame(render);
}

updateHud();
requestAnimationFrame(render);
