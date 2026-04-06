import process from 'node:process';
import { once } from 'node:events';
import WebSocket from 'ws';

const DRIVER_URL = process.env.SAFARI_WEBDRIVER_URL || 'http://127.0.0.1:4444';
const BASE_URL = process.env.STAGING_BASE_URL || 'https://tennis-table-ten.vercel.app/jeux_ping_pong.html';
const WS_URL = process.env.STAGING_WS_URL || 'wss://tennis-table-ws.onrender.com';
const ROOM_ID = `sf-${Date.now().toString().slice(-8)}`;
const LOCAL_REFERENCE_URL = process.env.LOCAL_REFERENCE_URL || BASE_URL;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function wd(method, path, body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DRIVER_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`WebDriver ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload.value;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createSafariSession() {
  const value = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'safari'
      }
    }
  });
  return value.sessionId;
}

async function deleteSafariSession(sessionId) {
  try {
    await wd('DELETE', `/session/${sessionId}`);
  } catch {}
}

async function executeAsync(sessionId, script, timeoutMs = 90_000) {
  return wd('POST', `/session/${sessionId}/execute/async`, {
    script,
    args: []
  }, timeoutMs);
}

async function navigate(sessionId, url) {
  await wd('POST', `/session/${sessionId}/url`, { url });
}

function buildGuestController(roomId) {
  const socket = new WebSocket(WS_URL);
  const lines = [];
  let joined = false;
  let closed = false;
  let lastInput = { up: false, down: false };
  const heartbeat = setInterval(() => {
    if (!joined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'input', ...lastInput }));
  }, 120);

  const ready = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('guest_timeout')), 45_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', playerName: 'Safari Guest' }));
    });
    socket.on('message', (buffer) => {
      const payload = JSON.parse(buffer.toString());
      lines.push(payload);
      if (payload.type === 'hello_ack') {
        socket.send(JSON.stringify({ type: 'join_room', roomId, playerName: 'Safari Guest' }));
      } else if (payload.type === 'room_joined') {
        joined = true;
        clearTimeout(timeoutId);
        resolve(payload);
      } else if (payload.type === 'error') {
        clearTimeout(timeoutId);
        reject(new Error(payload.message || 'guest_server_error'));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });

  return {
    async waitUntilJoined() {
      return ready;
    },
    sendInput(nextInput) {
      lastInput = { ...lastInput, ...nextInput };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', ...lastInput }));
      }
    },
    getLogTail(limit = 12) {
      return lines.slice(-limit);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      } catch {}
      if (socket.readyState !== WebSocket.CLOSED) {
        await Promise.race([
          once(socket, 'close').catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1_000))
        ]);
      }
    }
  };
}

function toLiteral(value) {
  return JSON.stringify(value);
}

async function measureLocalReference(sessionId) {
  await navigate(sessionId, LOCAL_REFERENCE_URL);
  const script = `
const cb = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  document.querySelector('#gameMode').value = 'two';
  document.querySelector('#gameMode').dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#startBtn').click();
  await wait(250);
  const captureId = window.__pongTestApi.startMotionCapture('safari-local-ref', 'cpu', {
    framesAfterResponse: 18,
    responseThreshold: 3,
    maxFrames: 180
  });
  const trigger = (type, key) => window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
  trigger('keydown', 'ArrowDown');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const capture = window.__pongTestApi.getMotionCapture(captureId);
    if (capture?.stopped) break;
    await wait(100);
  }
  trigger('keyup', 'ArrowDown');
  const capture = window.__pongTestApi.stopMotionCapture(captureId);
  cb({ capture, state: window.__pongTestApi.getState() });
})().catch(error => cb({ error: String(error) }));
`;
  const result = await executeAsync(sessionId, script);
  assert(!result.error, `Local Safari reference failed: ${result.error}`);
  assert(result.capture && !result.capture.timedOut, 'Local Safari reference capture timed out');
  return result.capture;
}

async function setupSafariHost(sessionId) {
  await navigate(sessionId, BASE_URL);
  const script = `
const cb = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  document.querySelector('#gameMode').value = 'online';
  document.querySelector('#gameMode').dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#startBtn').click();
  await wait(250);
  document.querySelector('#playerName').value = 'Safari Host';
  document.querySelector('#roomId').value = ${toLiteral(ROOM_ID)};
  document.querySelector('#serverUrl').value = ${toLiteral(WS_URL)};
  document.querySelector('#connectOnlineBtn').click();
  const connectDeadline = Date.now() + 45_000;
  while (Date.now() < connectDeadline) {
    const state = window.__pongTestApi.getState();
    if (state.connected) break;
    await wait(250);
  }
  let state = window.__pongTestApi.getState();
  if (!state.connected) {
    cb({ ok: false, stage: 'connect_failed', state, log: window.__pongTestApi.getOnlineDebugLog().slice(-16) });
    return;
  }
  document.querySelector('#createRoomBtn').click();
  const roomDeadline = Date.now() + 15_000;
  while (Date.now() < roomDeadline) {
    state = window.__pongTestApi.getState();
    if (state.roomId === ${toLiteral(ROOM_ID)}) break;
    await wait(200);
  }
  cb({ ok: true, stage: 'room_created', state: window.__pongTestApi.getState(), log: window.__pongTestApi.getOnlineDebugLog().slice(-16) });
})().catch(error => cb({ ok: false, stage: 'setup_exception', message: String(error) }));
`;
  const result = await executeAsync(sessionId, script);
  assert(result.ok, `Safari host setup failed: ${JSON.stringify(result)}`);
  return result;
}

async function waitForSafariReadyToStart(sessionId) {
  const script = `
const cb = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = window.__pongTestApi.getState();
    const button = document.querySelector('#startRoomBtn');
    if (state.connected && state.inRoom && state.isHost && state.waiting === false && button && !button.disabled) {
      cb({ ok: true, stage: 'ready', state, buttonText: button.textContent });
      return;
    }
    await wait(250);
  }
  const state = window.__pongTestApi.getState();
  const button = document.querySelector('#startRoomBtn');
  cb({
    ok: false,
    stage: 'before_click',
    state,
    buttonDisabled: button ? button.disabled : null,
    buttonText: button ? button.textContent : null,
    log: window.__pongTestApi.getOnlineDebugLog().slice(-20)
  });
})().catch(error => cb({ ok: false, stage: 'wait_exception', message: String(error) }));
`;
  return executeAsync(sessionId, script);
}

async function clickSafariStart(sessionId) {
  const script = `
const cb = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  document.querySelector('#startRoomBtn').click();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = window.__pongTestApi.getState();
    if (state.running) {
      cb({ ok: true, stage: 'running', state, log: window.__pongTestApi.getOnlineDebugLog().slice(-20) });
      return;
    }
    await wait(200);
  }
  cb({ ok: false, stage: 'after_click', state: window.__pongTestApi.getState(), log: window.__pongTestApi.getOnlineDebugLog().slice(-20) });
})().catch(error => cb({ ok: false, stage: 'start_exception', message: String(error) }));
`;
  return executeAsync(sessionId, script);
}

async function measureSafariOnlineLag(sessionId, guestController) {
  const startCaptureScript = `
const cb = arguments[arguments.length - 1];
(() => {
  const captureId = window.__pongTestApi.startMotionCapture('safari-online-lag', 'cpu', {
    framesAfterResponse: 18,
    responseThreshold: 3,
    maxFrames: 220
  });
  cb({ captureId });
})();
`;
  const { captureId } = await executeAsync(sessionId, startCaptureScript);
  guestController.sendInput({ down: true, up: false });
  const result = await executeAsync(sessionId, `
const cb = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const capture = window.__pongTestApi.getMotionCapture(${toLiteral(captureId)});
    if (capture?.stopped) {
      cb({ capture });
      return;
    }
    await wait(100);
  }
  cb({ capture: window.__pongTestApi.stopMotionCapture(${toLiteral(captureId)}) });
})().catch(error => cb({ error: String(error) }));
`);
  guestController.sendInput({ down: false, up: false });
  assert(!result.error, `Safari lag capture failed: ${result.error}`);
  assert(result.capture && !result.capture.timedOut, 'Safari online lag capture timed out');
  return result.capture;
}

async function main() {
  const sessionId = await createSafariSession();
  const guest = buildGuestController(ROOM_ID);
  try {
    const localReference = await measureLocalReference(sessionId);
    const hostSetup = await setupSafariHost(sessionId);
    const guestJoin = await guest.waitUntilJoined();
    const ready = await waitForSafariReadyToStart(sessionId);
    assert(ready.ok, `Safari host never became start-ready: ${JSON.stringify({ ready, hostSetup, guestJoin, guestLogTail: guest.getLogTail() })}`);
    const startResult = await clickSafariStart(sessionId);
    assert(startResult.ok, `Safari Start button did not launch the game: ${JSON.stringify({ startResult, guestLogTail: guest.getLogTail() })}`);
    const onlineLag = await measureSafariOnlineLag(sessionId, guest);

    const lagReport = {
      roomId: ROOM_ID,
      localReference,
      onlineLag,
      thresholds: {
        firstResponseMs: localReference.firstResponseMs + 700,
        maxJump: Math.max(localReference.maxJump + 26, 34),
        totalTravel: localReference.totalTravel * 0.6
      }
    };
    console.log('safari-staging-report', JSON.stringify(lagReport));

    assert(onlineLag.firstResponseMs <= lagReport.thresholds.firstResponseMs, `Safari lag firstResponseMs too high: ${onlineLag.firstResponseMs}`);
    assert(onlineLag.maxJump <= lagReport.thresholds.maxJump, `Safari lag maxJump too high: ${onlineLag.maxJump}`);
    assert(onlineLag.totalTravel >= lagReport.thresholds.totalTravel, `Safari lag totalTravel too low: ${onlineLag.totalTravel}`);
  } finally {
    await guest.close();
    await deleteSafariSession(sessionId);
  }
}

main().catch((error) => {
  console.error('safari-staging-failure', error.stack || String(error));
  process.exitCode = 1;
});
