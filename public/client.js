'use strict';

// O cliente desenha snapshots do servidor; nunca altera posições ou decide colisões.
const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
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
let feedTimer = null;
let hudUpdateScheduled = false;
const heldKeys = new Set();
let lastInputSignature = '';

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
  const active = new Set([...heldKeys].map((code) => KEY_TO_DIRECTION[code]).filter(Boolean));
  return {
    up: active.has('up'),
    down: active.has('down'),
    left: active.has('left'),
    right: active.has('right')
  };
}

function sendInput(force = false) {
  if (!hasJoined || !socket.connected) return;
  const input = currentInput();
  const signature = JSON.stringify(input);
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
  const before = heldKeys.size;
  heldKeys.add(event.code);
  if (heldKeys.size !== before) sendInput();
});

window.addEventListener('keyup', (event) => {
  if (!KEY_TO_DIRECTION[event.code]) return;
  event.preventDefault();
  if (heldKeys.delete(event.code)) sendInput();
});

window.addEventListener('blur', () => {
  if (heldKeys.size > 0) {
    heldKeys.clear();
    sendInput(true);
  }
});

// Um heartbeat modesto também recupera o estado se um pacote de input se perder.
setInterval(() => sendInput(true), 100);

socket.on('connect', () => {
  updateConnection('connected', 'Conectado');
  if (hasEnteredSession && !hasJoined && savedJoinPayload) emitJoin();
});

socket.on('disconnect', () => {
  updateConnection('disconnected', 'Reconectando...');
  hasJoined = false;
  joinPending = false;
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
  joinOverlay.classList.add('hidden');
  joinButton.disabled = false;
  joinButton.querySelector('span').textContent = 'LANÇAR NAVE';
  lastInputSignature = '';
  sendInput(true);
  updateHud();
});

socket.on('gameState', (snapshot) => {
  currentState = snapshot;
  scheduleHudUpdate();
});

socket.on('playerJoined', (player) => {
  showEvent(`${player.nickname} entrou na arena.`);
});

socket.on('playerLeft', (player) => {
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

// Os snapshots chegam a 60 Hz; a tabela DOM só precisa ser reconstruída a 10 Hz.
function scheduleHudUpdate() {
  if (hudUpdateScheduled) return;
  hudUpdateScheduled = true;
  setTimeout(() => {
    hudUpdateScheduled = false;
    updateHud();
  }, 100);
}

function setBanner(text, stateClass) {
  bannerText.textContent = text;
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

function drawBackground() {
  ctx.fillStyle = '#090b18';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (mapImage.complete && mapImage.naturalWidth > 0) {
    // Mantém a proporção do fundo e recorta o centro para preencher a arena 4:3.
    const scale = Math.max(canvas.width / mapImage.naturalWidth, canvas.height / mapImage.naturalHeight);
    const sourceWidth = canvas.width / scale;
    const sourceHeight = canvas.height / scale;
    const sourceX = (mapImage.naturalWidth - sourceWidth) / 2;
    const sourceY = (mapImage.naturalHeight - sourceHeight) / 2;
    ctx.drawImage(mapImage, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  }
  const shade = ctx.createLinearGradient(0, 0, 0, canvas.height);
  shade.addColorStop(0, 'rgba(5, 8, 22, .26)');
  shade.addColorStop(1, 'rgba(5, 7, 18, .49)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(168, 186, 255, .16)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
}

function drawMeteor(meteor) {
  const magnitude = Math.hypot(meteor.vx, meteor.vy) || 1;
  const trailLength = meteor.radius * 3.7;
  const tailX = meteor.x - (meteor.vx / magnitude) * trailLength;
  const tailY = meteor.y - (meteor.vy / magnitude) * trailLength;
  ctx.save();
  ctx.lineCap = 'round';
  const trail = ctx.createLinearGradient(tailX, tailY, meteor.x, meteor.y);
  trail.addColorStop(0, 'rgba(255, 85, 44, 0)');
  trail.addColorStop(.58, 'rgba(255, 117, 56, .16)');
  trail.addColorStop(1, 'rgba(255, 214, 145, .82)');
  ctx.strokeStyle = trail;
  ctx.lineWidth = Math.max(5, meteor.radius * .68);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(meteor.x, meteor.y);
  ctx.stroke();

  const glow = ctx.createRadialGradient(meteor.x, meteor.y, 1, meteor.x, meteor.y, meteor.radius * 1.8);
  glow.addColorStop(0, 'rgba(255, 205, 126, .34)');
  glow.addColorStop(1, 'rgba(255, 105, 52, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(meteor.x, meteor.y, meteor.radius * 1.8, 0, Math.PI * 2);
  ctx.fill();

  const seed = Number(meteor.id) || 1;
  const points = 10;
  const angles = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const jitter = .76 + seededRandom(seed * 13 + i) * .3;
    angles.push([Math.cos(angle) * meteor.radius * jitter, Math.sin(angle) * meteor.radius * jitter]);
  }
  const rock = ctx.createRadialGradient(meteor.x - meteor.radius * .35, meteor.y - meteor.radius * .45, 1, meteor.x, meteor.y, meteor.radius * 1.2);
  rock.addColorStop(0, '#ffca85');
  rock.addColorStop(.33, '#d36b45');
  rock.addColorStop(1, '#553b4a');
  ctx.beginPath();
  angles.forEach(([dx, dy], index) => {
    if (index === 0) ctx.moveTo(meteor.x + dx, meteor.y + dy);
    else ctx.lineTo(meteor.x + dx, meteor.y + dy);
  });
  ctx.closePath();
  ctx.fillStyle = rock;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 195, 130, .65)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = 'rgba(77, 43, 48, .62)';
  ctx.beginPath();
  ctx.arc(meteor.x + meteor.radius * .23, meteor.y - meteor.radius * .16, meteor.radius * .18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(meteor.x - meteor.radius * .28, meteor.y + meteor.radius * .24, meteor.radius * .1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function seededRandom(seed) {
  const value = Math.sin(seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function drawPlayer(player) {
  const ghost = player.alive !== true;
  const radius = player.radius || 20;
  const sprite = characterImages[player.character] || characterImages.nova;
  ctx.save();
  if (ghost) ctx.globalAlpha = .35;

  // Halo colorido para distinguir pilotos que usam o mesmo modelo de nave.
  const halo = ctx.createRadialGradient(player.x, player.y, radius * .3, player.x, player.y, radius * 1.8);
  halo.addColorStop(0, 'rgba(96, 210, 255, .13)');
  halo.addColorStop(1, 'rgba(96, 210, 255, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(player.x, player.y, radius * 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = player.color || '#63e4ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(player.x, player.y, radius + 2, 0, Math.PI * 2);
  ctx.stroke();
  if (player.id === myPlayerId) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (sprite.complete && sprite.naturalWidth > 0) {
    const size = radius * 2.25;
    ctx.drawImage(sprite, player.x - size / 2, player.y - size / 2, size, size);
  } else {
    ctx.fillStyle = player.color || '#63e4ff';
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius * .72, 0, Math.PI * 2);
    ctx.fill();
  }

  const label = ghost ? `${player.nickname} [Fantasma]` : player.nickname;
  const labelY = player.y - radius - 10;
  ctx.font = '700 12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(4, 7, 18, .92)';
  ctx.strokeText(label, player.x, labelY);
  ctx.fillStyle = player.id === myPlayerId ? '#ffffff' : '#e8edff';
  ctx.fillText(label, player.x, labelY);
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();
  for (const meteor of currentState.meteors || []) drawMeteor(meteor);
  for (const player of Object.values(currentState.players || {})) drawPlayer(player);
  requestAnimationFrame(render);
}

updateHud();
requestAnimationFrame(render);
