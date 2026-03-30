import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '8080', 10);
const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 1000 / 60;
const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 110;
const PADDLE_MARGIN = 14;
const FIELD_WIDTH = 840;
const FIELD_HEIGHT = 520;
const MAX_SCORE_DEFAULT = 3;
const BONUS_EFFECT_DURATION_MS = 15000;
const POWER_UP_VISIBLE_DURATION_MS = 30000;
const MAX_POWER_UPS_ON_TABLE = 2;
const SERVE_SPEED_FACTOR = 0.76;
const SERVE_DELAY_MS = 950;
const ALLOW_TEST_COMMANDS = process.env.ALLOW_TEST_COMMANDS === '1';

const rooms = new Map();
const clients = new Map();
let nextClientId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createBall(direction = 1, speedFactor = 1) {
  const baseSpeed = 6;
  const angle = (Math.random() * Math.PI / 4) - (Math.PI / 8);
  return {
    x: FIELD_WIDTH / 2,
    y: FIELD_HEIGHT / 2,
    r: 9,
    vx: direction * baseSpeed * speedFactor * Math.cos(angle),
    vy: baseSpeed * speedFactor * Math.sin(angle)
  };
}

function createObstacle() {
  const width = 14;
  const height = Math.max(80, Math.round(FIELD_HEIGHT * 0.24));
  return {
    x: Math.round(FIELD_WIDTH / 2 - width / 2),
    y: Math.round((FIELD_HEIGHT - height) / 2),
    w: width,
    h: height,
    vy: 2.3
  };
}

function scheduleNextPowerUpAt() {
  return Date.now() + 3000 + Math.random() * 4000;
}

function createPowerUp(type) {
  const margin = 96;
  return {
    x: margin + Math.random() * (FIELD_WIDTH - (2 * margin)),
    y: 72 + Math.random() * (FIELD_HEIGHT - 144),
    r: 23,
    type,
    visibleUntil: Date.now() + POWER_UP_VISIBLE_DURATION_MS,
    vy: (Math.random() > 0.5 ? 1 : -1) * (1.2 + Math.random() * 1.4),
    drift: Math.random() * Math.PI * 2
  };
}

function createRoom(id) {
  return {
    id,
    hostId: null,
    players: { p1: null, p2: null },
    inputs: {
      p1: { up: false, down: false },
      p2: { up: false, down: false }
    },
    names: { p1: 'Player 1', p2: 'Player 2' },
    paddles: {
      p1: { x: PADDLE_MARGIN, y: (FIELD_HEIGHT - PADDLE_HEIGHT) / 2, w: PADDLE_WIDTH, h: PADDLE_HEIGHT, speed: 8, baseH: PADDLE_HEIGHT, baseSpeed: 8 },
      p2: { x: FIELD_WIDTH - PADDLE_WIDTH - PADDLE_MARGIN, y: (FIELD_HEIGHT - PADDLE_HEIGHT) / 2, w: PADDLE_WIDTH, h: PADDLE_HEIGHT, speed: 8, baseH: PADDLE_HEIGHT, baseSpeed: 8 }
    },
    balls: [createBall(1)],
    score: { p1: 0, p2: 0 },
    obstacle: createObstacle(),
    powerUps: [],
    activeEffects: [],
    nextPowerUpAt: scheduleNextPowerUpAt(),
    duplicateSpawnedThisPoint: false,
    lastHit: 'p1',
    waitingForServe: true,
    serveResumeAt: Date.now() + SERVE_DELAY_MS,
    running: false,
    paused: false,
    winner: null,
    pointsToWin: MAX_SCORE_DEFAULT
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  return rooms.get(roomId);
}

function roomPlayerCount(room) {
  return (room.players.p1 ? 1 : 0) + (room.players.p2 ? 1 : 0);
}

function getClientMeta(ws) {
  return clients.get(ws) || null;
}

function getConnectedUsersSnapshot() {
  return Array.from(clients.values()).map((client) => ({
    id: client.id,
    name: client.name,
    status: client.roomId ? `room ${client.roomId}` : 'lobby'
  }));
}

function getRoomsSnapshot() {
  return Array.from(rooms.values()).map((room) => ({
    id: room.id,
    count: roomPlayerCount(room),
    hostName: room.hostId ? Array.from(clients.values()).find((client) => client.id === room.hostId)?.name || 'Host' : 'Host',
    running: room.running
  }));
}

function broadcastLobby() {
  const payload = {
    type: 'lobby',
    connectedUsers: getConnectedUsersSnapshot(),
    rooms: getRoomsSnapshot()
  };
  for (const ws of clients.keys()) send(ws, payload);
}

function resetRoomState(room, serveDirection = 1, { delayMs = SERVE_DELAY_MS, speedFactor = SERVE_SPEED_FACTOR } = {}) {
  room.paddles.p1.y = (FIELD_HEIGHT - room.paddles.p1.h) / 2;
  room.paddles.p2.y = (FIELD_HEIGHT - room.paddles.p2.h) / 2;
  room.paddles.p1.h = room.paddles.p1.baseH;
  room.paddles.p2.h = room.paddles.p2.baseH;
  room.paddles.p1.speed = room.paddles.p1.baseSpeed;
  room.paddles.p2.speed = room.paddles.p2.baseSpeed;
  room.balls = [createBall(serveDirection, speedFactor)];
  room.obstacle = createObstacle();
  room.powerUps = [];
  room.activeEffects = [];
  room.nextPowerUpAt = scheduleNextPowerUpAt();
  room.duplicateSpawnedThisPoint = false;
  room.lastHit = 'p1';
  room.waitingForServe = true;
  room.serveResumeAt = Date.now() + delayMs;
  room.winner = null;
  room.paused = false;
  room.running = roomPlayerCount(room) === 2;
}

function restartRoom(room, pointsToWin) {
  room.score.p1 = 0;
  room.score.p2 = 0;
  room.pointsToWin = clamp(pointsToWin || MAX_SCORE_DEFAULT, 1, 15);
  resetRoomState(room, Math.random() > 0.5 ? 1 : -1);
}

function getRoleForClient(room, ws) {
  if (room.players.p1 === ws) return 'p1';
  if (room.players.p2 === ws) return 'p2';
  return null;
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function serializeRoom(room) {
  const now = Date.now();
  return {
    roomId: room.id,
    field: { width: FIELD_WIDTH, height: FIELD_HEIGHT },
    score: room.score,
    names: room.names,
    paddles: room.paddles,
    ball: room.balls[0] || null,
    balls: room.balls,
    obstacles: room.obstacle ? [room.obstacle] : [],
    powerUps: room.powerUps,
    activeEffects: room.activeEffects.map((effect) => ({
      owner: effect.owner,
      type: effect.type,
      durationMs: effect.durationMs,
      remainingMs: Math.max(0, effect.expiresAt - now)
    })),
    waitingForServe: !!room.waitingForServe,
    serveCountdownMs: Math.max(0, (room.serveResumeAt || 0) - now),
    running: room.running,
    paused: !!room.paused,
    winner: room.winner,
    waitingForOpponent: roomPlayerCount(room) < 2,
    pointsToWin: room.pointsToWin,
    hostId: room.hostId
  };
}

function broadcastRoom(room) {
  for (const role of ['p1', 'p2']) {
    const ws = room.players[role];
    if (!ws) continue;
    send(ws, {
      type: 'state',
      role,
      state: serializeRoom(room)
    });
  }
}

function notifyRoom(room, text) {
  for (const role of ['p1', 'p2']) {
    const ws = room.players[role];
    if (!ws) continue;
    send(ws, { type: 'message', text });
  }
}

function sendRoomStatus(room) {
  const payload = {
    type: 'room_status',
    roomId: room.id,
    names: room.names,
    waitingForOpponent: roomPlayerCount(room) < 2,
    hostId: room.hostId
  };
  for (const role of ['p1', 'p2']) {
    const ws = room.players[role];
    if (!ws) continue;
    send(ws, payload);
  }
}

function leaveCurrentRoom(ws) {
  const client = getClientMeta(ws);
  if (!client || !client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    client.role = null;
    client.isHost = false;
    return;
  }

  const role = client.role;
  if (role) {
    room.players[role] = null;
    room.inputs[role] = { up: false, down: false };
    room.names[role] = role === 'p1' ? 'Player 1' : 'Player 2';
  }

  room.running = false;
  room.winner = null;

  if (room.hostId === client.id) {
    const successorRole = room.players.p1 ? 'p1' : room.players.p2 ? 'p2' : null;
    if (successorRole) {
      const successorMeta = getClientMeta(room.players[successorRole]);
      room.hostId = successorMeta?.id || null;
      if (successorMeta) successorMeta.isHost = true;
    } else {
      room.hostId = null;
    }
  }

  if (roomPlayerCount(room) === 0) {
    rooms.delete(room.id);
  } else {
    sendRoomStatus(room);
    notifyRoom(room, 'Un joueur a quitte la room.');
    broadcastRoom(room);
  }

  client.roomId = null;
  client.role = null;
  client.isHost = false;
  broadcastLobby();
}

function assignClientName(ws, requestedName, fallbackName = null) {
  const client = getClientMeta(ws);
  if (!client) return;
  const cleanName = String(requestedName || '').trim();
  client.name = cleanName || fallbackName || client.name || `Player ${client.id}`;
}

function createRoomForClient(ws, payload) {
  const client = getClientMeta(ws);
  if (!client) return;
  if (client.roomId) {
    send(ws, { type: 'error', message: 'Quittez votre room actuelle avant d’en creer une autre.' });
    return;
  }
  const roomId = String(payload.roomId || '').trim() || `room-${client.id}`;
  if (rooms.has(roomId)) {
    send(ws, { type: 'error', message: 'Cette room existe deja.' });
    return;
  }
  assignClientName(ws, payload.playerName, 'Player 1');
  const room = createRoom(roomId);
  room.hostId = client.id;
  room.players.p1 = ws;
  room.names.p1 = client.name;
  room.pointsToWin = clamp(parseInt(payload.pointsToWin || MAX_SCORE_DEFAULT, 10) || MAX_SCORE_DEFAULT, 1, 15);
  rooms.set(roomId, room);

  client.roomId = roomId;
  client.role = 'p1';
  client.isHost = true;

  send(ws, {
    type: 'room_joined',
    role: 'p1',
    roomId,
    isHost: true,
    playerName: client.name,
    names: room.names,
    waitingForOpponent: true
  });
  sendRoomStatus(room);
  broadcastRoom(room);
  broadcastLobby();
}

function joinExistingRoom(ws, payload) {
  const client = getClientMeta(ws);
  if (!client) return;
  if (client.roomId) {
    send(ws, { type: 'error', message: 'Quittez votre room actuelle avant d’en rejoindre une autre.' });
    return;
  }
  const roomId = String(payload.roomId || '').trim();
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: 'Room introuvable.' });
    return;
  }
  if (roomPlayerCount(room) >= 2) {
    send(ws, { type: 'error', message: 'Cette room est deja complete.' });
    return;
  }

  assignClientName(ws, payload.playerName, 'Player 2');
  const role = room.players.p1 ? 'p2' : 'p1';
  room.players[role] = ws;
  room.names[role] = client.name;

  client.roomId = roomId;
  client.role = role;
  client.isHost = room.hostId === client.id;

  send(ws, {
    type: 'room_joined',
    role,
    roomId,
    isHost: client.isHost,
    playerName: client.name,
    names: room.names,
    waitingForOpponent: roomPlayerCount(room) < 2
  });
  sendRoomStatus(room);
  notifyRoom(room, 'Les deux joueurs sont dans la room. L’hote peut lancer la partie.');
  broadcastRoom(room);
  broadcastLobby();
}

function startRoomGame(ws, payload) {
  const client = getClientMeta(ws);
  if (!client || !client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;
  if (room.hostId !== client.id) {
    send(ws, { type: 'error', message: 'Seul le createur de la room peut lancer la partie.' });
    return;
  }
  if (roomPlayerCount(room) < 2) {
    send(ws, { type: 'error', message: 'Il faut 2 joueurs pour lancer la partie.' });
    return;
  }
  room.score.p1 = 0;
  room.score.p2 = 0;
  room.pointsToWin = clamp(parseInt(payload.pointsToWin || MAX_SCORE_DEFAULT, 10) || MAX_SCORE_DEFAULT, 1, 15);
  resetRoomState(room, Math.random() > 0.5 ? 1 : -1);
  notifyRoom(room, 'La partie commence.');
  broadcastRoom(room);
}

function setRoomPaused(ws, shouldPause) {
  const client = getClientMeta(ws);
  if (!client || !client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room || !room.running || room.winner) return;
  room.paused = !!shouldPause;
  notifyRoom(room, room.paused ? 'Partie en pause.' : 'Partie reprise.');
  broadcastRoom(room);
}

function forceWinnerForTests(ws, winner) {
  if (!ALLOW_TEST_COMMANDS) return;
  const client = getClientMeta(ws);
  if (!client || !client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;
  const normalizedWinner = winner === 'p2' ? 'p2' : 'p1';
  room.score[normalizedWinner] = room.pointsToWin;
  room.winner = normalizedWinner;
  room.running = false;
  room.paused = false;
  room.waitingForServe = false;
  notifyRoom(room, `Test: victoire forcee pour ${room.names[normalizedWinner] || normalizedWinner}.`);
  broadcastRoom(room);
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client) return;
  leaveCurrentRoom(ws);
  clients.delete(ws);
  broadcastLobby();
}

function updatePaddle(paddle, input) {
  if (input.up) paddle.y -= paddle.speed;
  if (input.down) paddle.y += paddle.speed;
  paddle.y = clamp(paddle.y, 0, FIELD_HEIGHT - paddle.h);
}

function applyActiveEffects(room) {
  const now = Date.now();
  room.activeEffects = room.activeEffects.filter((effect) => effect.expiresAt > now);

  for (const role of ['p1', 'p2']) {
    const paddle = room.paddles[role];
    paddle.h = paddle.baseH;
    paddle.speed = paddle.baseSpeed;
  }

  for (const effect of room.activeEffects) {
    const paddle = room.paddles[effect.owner];
    if (!paddle) continue;
    if (effect.type === 'expand') {
      paddle.h = Math.min(paddle.baseH * 1.8, paddle.baseH * 2.0);
    } else if (effect.type === 'shrink') {
      paddle.h = Math.max(paddle.baseH * 0.55, paddle.baseH * 0.6);
    } else if (effect.type === 'paddleSpeed') {
      paddle.speed = paddle.baseSpeed * 1.65;
    }
    paddle.y = clamp(paddle.y, 0, FIELD_HEIGHT - paddle.h);
  }
}

function registerEffect(room, owner, type, durationMs) {
  room.activeEffects = room.activeEffects.filter((effect) => !(effect.owner === owner && effect.type === type));
  room.activeEffects.push({
    owner,
    type,
    durationMs,
    expiresAt: Date.now() + durationMs
  });
}

function resolveBallCollisions(room) {
  for (let i = 0; i < room.balls.length; i += 1) {
    for (let j = i + 1; j < room.balls.length; j += 1) {
      const firstBall = room.balls[i];
      const secondBall = room.balls[j];
      const dx = secondBall.x - firstBall.x;
      const dy = secondBall.y - firstBall.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = firstBall.r + secondBall.r;
      if (distance === 0 || distance >= minDistance) continue;

      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;

      firstBall.x -= nx * overlap * 0.5;
      firstBall.y -= ny * overlap * 0.5;
      secondBall.x += nx * overlap * 0.5;
      secondBall.y += ny * overlap * 0.5;

      const relativeVx = secondBall.vx - firstBall.vx;
      const relativeVy = secondBall.vy - firstBall.vy;
      const approachSpeed = (relativeVx * nx) + (relativeVy * ny);
      if (approachSpeed >= 0) continue;

      const tangentX = -ny;
      const tangentY = nx;
      const firstNormal = (firstBall.vx * nx) + (firstBall.vy * ny);
      const firstTangent = (firstBall.vx * tangentX) + (firstBall.vy * tangentY);
      const secondNormal = (secondBall.vx * nx) + (secondBall.vy * ny);
      const secondTangent = (secondBall.vx * tangentX) + (secondBall.vy * tangentY);

      const restitution = 1.02;
      const exchangedFirstNormal = secondNormal * restitution;
      const exchangedSecondNormal = firstNormal * restitution;

      firstBall.vx = (exchangedFirstNormal * nx) + (firstTangent * tangentX);
      firstBall.vy = (exchangedFirstNormal * ny) + (firstTangent * tangentY);
      secondBall.vx = (exchangedSecondNormal * nx) + (secondTangent * tangentX);
      secondBall.vy = (exchangedSecondNormal * ny) + (secondTangent * tangentY);

      const minSpeed = 4.5;
      const firstSpeed = Math.hypot(firstBall.vx, firstBall.vy);
      const secondSpeed = Math.hypot(secondBall.vx, secondBall.vy);
      if (firstSpeed < minSpeed) {
        const ratio = minSpeed / Math.max(0.001, firstSpeed);
        firstBall.vx *= ratio;
        firstBall.vy *= ratio;
      }
      if (secondSpeed < minSpeed) {
        const ratio = minSpeed / Math.max(0.001, secondSpeed);
        secondBall.vx *= ratio;
        secondBall.vy *= ratio;
      }
    }
  }
}

function updateObstacle(room) {
  if (!room.obstacle) return;
  const obstacle = room.obstacle;
  obstacle.y += obstacle.vy;
  if (obstacle.y < 10) {
    obstacle.y = 10;
    obstacle.vy = Math.abs(obstacle.vy);
  }
  if (obstacle.y + obstacle.h > FIELD_HEIGHT - 10) {
    obstacle.y = FIELD_HEIGHT - 10 - obstacle.h;
    obstacle.vy = -Math.abs(obstacle.vy);
  }

  for (const activeBall of room.balls) {
    if (
      activeBall.x + activeBall.r > obstacle.x &&
      activeBall.x - activeBall.r < obstacle.x + obstacle.w &&
      activeBall.y + activeBall.r > obstacle.y &&
      activeBall.y - activeBall.r < obstacle.y + obstacle.h
    ) {
      const obstacleCenterY = obstacle.y + (obstacle.h / 2);
      const relative = (activeBall.y - obstacleCenterY) / (obstacle.h / 2);
      activeBall.vx = -activeBall.vx;
      activeBall.vy += relative * 2.0;
      if (activeBall.vx > 0) activeBall.x = obstacle.x + obstacle.w + activeBall.r + 1;
      else activeBall.x = obstacle.x - activeBall.r - 1;
    }
  }
}

function getAvailablePowerTypes(room) {
  const spawnableTypes = ['expand', 'shrink', 'paddleSpeed'];
  if (!room.duplicateSpawnedThisPoint) spawnableTypes.push('duplicate');
  return spawnableTypes.filter((type) => !room.powerUps.some((powerUp) => powerUp.type === type));
}

function spawnPowerUp(room) {
  if (room.powerUps.length >= MAX_POWER_UPS_ON_TABLE) return;
  const availableTypes = getAvailablePowerTypes(room);
  if (!availableTypes.length) return;
  const type = availableTypes[Math.floor(Math.random() * availableTypes.length)];
  const powerUp = createPowerUp(type);
  room.powerUps.push(powerUp);
  if (type === 'duplicate') room.duplicateSpawnedThisPoint = true;
}

function applyPowerUp(room, owner, type, sourceBall) {
  if (type === 'expand' || type === 'shrink' || type === 'paddleSpeed') {
    registerEffect(room, owner, type, BONUS_EFFECT_DURATION_MS);
    return;
  }

  if (type === 'duplicate' && room.balls.length === 1) {
    const speed = Math.max(6, Math.hypot(sourceBall.vx, sourceBall.vy));
    const horizontalSign = Math.sign(sourceBall.vx) || 1;
    const verticalSign = sourceBall.vy === 0 ? (Math.random() > 0.5 ? 1 : -1) : Math.sign(sourceBall.vy);
    const splitAngle = Math.PI / 6;
    const leadVx = horizontalSign * Math.cos(splitAngle) * speed;
    const leadVy = verticalSign * Math.sin(splitAngle) * speed;

    sourceBall.vx = leadVx;
    sourceBall.vy = leadVy;
    sourceBall.x += horizontalSign * 12;
    sourceBall.y += verticalSign * 18;

    room.balls.push({
      ...createBall(1),
      x: sourceBall.x - (horizontalSign * 24),
      y: sourceBall.y - (verticalSign * 36),
      vx: -leadVx,
      vy: -leadVy,
      r: sourceBall.r
    });
  }
}

function updatePowerUps(room) {
  const now = Date.now();
  if (room.powerUps.length < MAX_POWER_UPS_ON_TABLE && now > room.nextPowerUpAt) {
    spawnPowerUp(room);
    room.nextPowerUpAt = scheduleNextPowerUpAt();
  }

  room.powerUps = room.powerUps.filter((powerUp) => {
    powerUp.y += powerUp.vy;
    powerUp.drift += 0.03;
    powerUp.x += Math.sin(powerUp.drift) * 0.75;
    if (powerUp.y - powerUp.r < 24) {
      powerUp.y = 24 + powerUp.r;
      powerUp.vy = Math.abs(powerUp.vy);
    }
    if (powerUp.y + powerUp.r > FIELD_HEIGHT - 24) {
      powerUp.y = FIELD_HEIGHT - 24 - powerUp.r;
      powerUp.vy = -Math.abs(powerUp.vy);
    }
    if (now > powerUp.visibleUntil) return false;

    for (const activeBall of room.balls) {
      const dx = activeBall.x - powerUp.x;
      const dy = activeBall.y - powerUp.y;
      if (Math.hypot(dx, dy) <= activeBall.r + powerUp.r) {
        applyPowerUp(room, room.lastHit, powerUp.type, activeBall);
        room.nextPowerUpAt = scheduleNextPowerUpAt();
        return false;
      }
    }
    return true;
  });
}

function handlePaddleBounce(ball, paddle, direction) {
  if (direction < 0 && ball.vx >= 0) return false;
  if (direction > 0 && ball.vx <= 0) return false;
  if (ball.x - ball.r >= paddle.x + paddle.w) return false;
  if (ball.x + ball.r <= paddle.x) return false;
  if (ball.y - ball.r >= paddle.y + paddle.h) return false;
  if (ball.y + ball.r <= paddle.y) return false;

  const relative = (ball.y - (paddle.y + paddle.h / 2)) / (paddle.h / 2);
  const bounceAngle = relative * (Math.PI / 3);
  const currentSpeed = Math.hypot(ball.vx, ball.vy);
  const speed = Math.min(18, currentSpeed * 1.06);

  if (direction < 0) {
    ball.x = paddle.x + paddle.w + ball.r;
    ball.vx = Math.abs(speed * Math.cos(bounceAngle));
  } else {
    ball.x = paddle.x - ball.r;
    ball.vx = -Math.abs(speed * Math.cos(bounceAngle));
  }
  ball.vy = speed * Math.sin(bounceAngle);
  return true;
}

function tickRoom(room) {
  if (roomPlayerCount(room) < 2 || !room.running || room.winner) return;
  if (room.paused) return;

  applyActiveEffects(room);
  updatePaddle(room.paddles.p1, room.inputs.p1);
  updatePaddle(room.paddles.p2, room.inputs.p2);

  if (room.waitingForServe) {
    if (Date.now() < room.serveResumeAt) return;
    room.waitingForServe = false;
  }

  for (const ball of room.balls) {
    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.y - ball.r <= 0) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y + ball.r >= FIELD_HEIGHT) {
      ball.y = FIELD_HEIGHT - ball.r;
      ball.vy = -Math.abs(ball.vy);
    }

    if (handlePaddleBounce(ball, room.paddles.p1, -1)) room.lastHit = 'p1';
    else if (handlePaddleBounce(ball, room.paddles.p2, 1)) room.lastHit = 'p2';
  }

  resolveBallCollisions(room);
  updateObstacle(room);
  updatePowerUps(room);

  if (room.balls.some((ball) => ball.x - ball.r <= 0)) {
    room.score.p2 += 1;
    if (room.score.p2 >= room.pointsToWin) {
      room.winner = 'p2';
      room.running = false;
    } else {
      resetRoomState(room, -1);
    }
  } else if (room.balls.some((ball) => ball.x + ball.r >= FIELD_WIDTH)) {
    room.score.p1 += 1;
    if (room.score.p1 >= room.pointsToWin) {
      room.winner = 'p1';
      room.running = false;
    } else {
      resetRoomState(room, 1);
    }
  }
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false });

wss.on('connection', (ws) => {
  if (ws._socket && typeof ws._socket.setNoDelay === 'function') {
    ws._socket.setNoDelay(true);
  }
  const client = {
    id: nextClientId,
    name: `Player ${nextClientId}`,
    roomId: null,
    role: null,
    isHost: false
  };
  nextClientId += 1;
  clients.set(ws, client);
  send(ws, { type: 'welcome', message: 'Connexion etablie.' });
  broadcastLobby();

  ws.on('message', (buffer) => {
    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch {
      send(ws, { type: 'error', message: 'Message invalide.' });
      return;
    }

    if (payload.type === 'hello') {
      assignClientName(ws, payload.playerName);
      const currentClient = clients.get(ws);
      send(ws, { type: 'hello_ack', clientId: currentClient?.id, playerName: currentClient?.name });
      broadcastLobby();
      return;
    }

    if (payload.type === 'create_room') {
      createRoomForClient(ws, payload);
      return;
    }

    if (payload.type === 'join_room') {
      joinExistingRoom(ws, payload);
      return;
    }

    if (payload.type === 'start_game') {
      startRoomGame(ws, payload);
      return;
    }

    if (payload.type === 'pause_game') {
      setRoomPaused(ws, true);
      return;
    }

    if (payload.type === 'resume_game') {
      setRoomPaused(ws, false);
      return;
    }

    if (payload.type === 'test_force_winner') {
      forceWinnerForTests(ws, payload.winner);
      return;
    }

    const client = clients.get(ws);
    if (!client) {
      send(ws, { type: 'error', message: 'Rejoignez une salle avant de jouer.' });
      return;
    }
    const room = rooms.get(client.roomId);
    if (!room) return;

    if (payload.type === 'input') {
      room.inputs[client.role] = {
        up: !!payload.up,
        down: !!payload.down
      };
      return;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, TICK_MS);

setInterval(() => {
  for (const room of rooms.values()) broadcastRoom(room);
}, SNAPSHOT_MS);

console.log(`WebSocket server listening on ws://localhost:${PORT}`);
