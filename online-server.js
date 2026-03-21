import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '8080', 10);
const TICK_MS = 1000 / 60;
const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 110;
const PADDLE_MARGIN = 14;
const FIELD_WIDTH = 840;
const FIELD_HEIGHT = 520;
const MAX_SCORE_DEFAULT = 3;

const rooms = new Map();
const clients = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createBall(direction = 1) {
  const baseSpeed = 6;
  const angle = (Math.random() * Math.PI / 4) - (Math.PI / 8);
  return {
    x: FIELD_WIDTH / 2,
    y: FIELD_HEIGHT / 2,
    r: 9,
    vx: direction * baseSpeed * Math.cos(angle),
    vy: baseSpeed * Math.sin(angle)
  };
}

function createRoom(id) {
  return {
    id,
    players: { p1: null, p2: null },
    inputs: {
      p1: { up: false, down: false },
      p2: { up: false, down: false }
    },
    names: { p1: 'Player 1', p2: 'Player 2' },
    paddles: {
      p1: { x: PADDLE_MARGIN, y: (FIELD_HEIGHT - PADDLE_HEIGHT) / 2, w: PADDLE_WIDTH, h: PADDLE_HEIGHT, speed: 8 },
      p2: { x: FIELD_WIDTH - PADDLE_WIDTH - PADDLE_MARGIN, y: (FIELD_HEIGHT - PADDLE_HEIGHT) / 2, w: PADDLE_WIDTH, h: PADDLE_HEIGHT, speed: 8 }
    },
    ball: createBall(1),
    score: { p1: 0, p2: 0 },
    running: false,
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

function resetRoomState(room, serveDirection = 1) {
  room.paddles.p1.y = (FIELD_HEIGHT - room.paddles.p1.h) / 2;
  room.paddles.p2.y = (FIELD_HEIGHT - room.paddles.p2.h) / 2;
  room.ball = createBall(serveDirection);
  room.winner = null;
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
  return {
    roomId: room.id,
    field: { width: FIELD_WIDTH, height: FIELD_HEIGHT },
    score: room.score,
    names: room.names,
    paddles: room.paddles,
    ball: room.ball,
    running: room.running,
    winner: room.winner,
    waitingForOpponent: roomPlayerCount(room) < 2,
    pointsToWin: room.pointsToWin
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

function joinRoom(ws, payload) {
  const roomId = String(payload.roomId || 'public').trim() || 'public';
  const room = getOrCreateRoom(roomId);

  let role = null;
  if (!room.players.p1) role = 'p1';
  else if (!room.players.p2) role = 'p2';
  else {
    send(ws, { type: 'error', message: 'Cette salle est deja complete.' });
    return;
  }

  clients.set(ws, { roomId, role });
  room.players[role] = ws;

  const fallbackName = role === 'p1' ? 'Player 1' : 'Player 2';
  const providedName = String(payload.playerName || '').trim();
  room.names[role] = providedName || fallbackName;
  room.pointsToWin = clamp(parseInt(payload.pointsToWin || MAX_SCORE_DEFAULT, 10) || MAX_SCORE_DEFAULT, 1, 15);

  if (roomPlayerCount(room) === 2) {
    resetRoomState(room, Math.random() > 0.5 ? 1 : -1);
    notifyRoom(room, 'Les deux joueurs sont connectes. La partie commence.');
  } else {
    room.running = false;
  }

  send(ws, {
    type: 'joined',
    role,
    roomId,
    playerName: room.names[role]
  });
  broadcastRoom(room);
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client) return;
  const room = rooms.get(client.roomId);
  if (!room) {
    clients.delete(ws);
    return;
  }

  room.players[client.role] = null;
  room.inputs[client.role] = { up: false, down: false };
  room.names[client.role] = client.role === 'p1' ? 'Player 1' : 'Player 2';
  room.running = false;
  room.winner = null;

  const remainingRole = room.players.p1 ? 'p1' : room.players.p2 ? 'p2' : null;
  if (remainingRole) {
    notifyRoom(room, 'L’autre joueur a quitte la partie.');
    broadcastRoom(room);
  } else {
    rooms.delete(room.id);
  }

  clients.delete(ws);
}

function updatePaddle(paddle, input) {
  if (input.up) paddle.y -= paddle.speed;
  if (input.down) paddle.y += paddle.speed;
  paddle.y = clamp(paddle.y, 0, FIELD_HEIGHT - paddle.h);
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

  updatePaddle(room.paddles.p1, room.inputs.p1);
  updatePaddle(room.paddles.p2, room.inputs.p2);

  const ball = room.ball;
  ball.x += ball.vx;
  ball.y += ball.vy;

  if (ball.y - ball.r <= 0) {
    ball.y = ball.r;
    ball.vy = Math.abs(ball.vy);
  } else if (ball.y + ball.r >= FIELD_HEIGHT) {
    ball.y = FIELD_HEIGHT - ball.r;
    ball.vy = -Math.abs(ball.vy);
  }

  handlePaddleBounce(ball, room.paddles.p1, -1);
  handlePaddleBounce(ball, room.paddles.p2, 1);

  if (ball.x - ball.r <= 0) {
    room.score.p2 += 1;
    if (room.score.p2 >= room.pointsToWin) {
      room.winner = 'p2';
      room.running = false;
    } else {
      room.ball = createBall(-1);
    }
  } else if (ball.x + ball.r >= FIELD_WIDTH) {
    room.score.p1 += 1;
    if (room.score.p1 >= room.pointsToWin) {
      room.winner = 'p1';
      room.running = false;
    } else {
      room.ball = createBall(1);
    }
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  send(ws, { type: 'welcome', message: 'Connexion etablie.' });

  ws.on('message', (buffer) => {
    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch {
      send(ws, { type: 'error', message: 'Message invalide.' });
      return;
    }

    if (payload.type === 'join') {
      joinRoom(ws, payload);
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

    if (payload.type === 'restart') {
      restartRoom(room, payload.pointsToWin);
      notifyRoom(room, 'Nouvelle manche.');
      broadcastRoom(room);
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    tickRoom(room);
    broadcastRoom(room);
  }
}, TICK_MS);

console.log(`WebSocket server listening on ws://localhost:${PORT}`);
