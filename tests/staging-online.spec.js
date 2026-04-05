import { test, expect } from '@playwright/test';

function createMotionCaptureId(prefix = 'motion') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createShortRoomId(prefix = 'stg') {
  return `${prefix}-${Date.now().toString().slice(-8)}`;
}

function getStagingSocketUrl() {
  return process.env.STAGING_WS_URL || 'wss://tennis-table-ws.onrender.com';
}

async function getTestState(page) {
  return page.evaluate(() => window.__pongTestApi.getState());
}

async function openOnlineLobby(page, playerName) {
  await page.goto('/jeux_ping_pong.html');
  await page.locator('#gameMode').selectOption('online');
  await page.getByRole('button', { name: 'Lobby online' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby Online' })).toBeVisible();
  await page.locator('#playerName').fill(playerName);
  await page.locator('#serverUrl').fill(getStagingSocketUrl());
}

async function openLocalTwoPlayerGame(page) {
  await page.goto('/jeux_ping_pong.html');
  await page.locator('#gameMode').selectOption('two');
  await page.getByRole('button', { name: 'Jouer' }).click();
  await expect(page.locator('#gameContainer')).toHaveClass(/playing/);
}

async function createIsolatedContext(browser) {
  return browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
}

async function startMotionCapture(page, target = 'player', prefix = 'capture', options = {}) {
  const captureId = createMotionCaptureId(prefix);
  await page.evaluate(({ id, observedTarget, captureOptions }) => {
    window.__pongTestApi.startMotionCapture(id, observedTarget, captureOptions);
  }, { id: captureId, observedTarget: target, captureOptions: options });
  return captureId;
}

async function getMotionCapture(page, captureId) {
  return page.evaluate((id) => window.__pongTestApi.getMotionCapture(id), captureId);
}

async function stopMotionCapture(page, captureId) {
  return page.evaluate((id) => window.__pongTestApi.stopMotionCapture(id), captureId);
}

async function captureMotionWhileHolding({
  actionPage,
  observedPage,
  key = 'w',
  observedTarget = 'player',
  framesAfterResponse = 18
}) {
  await actionPage.locator('#game').click();
  const captureId = await startMotionCapture(observedPage, observedTarget, key, {
    framesAfterResponse
  });
  await actionPage.keyboard.down(key);
  await expect.poll(async () => {
    const capture = await getMotionCapture(observedPage, captureId);
    return capture?.stopped ?? false;
  }, { timeout: 15_000 }).toBe(true);
  await actionPage.keyboard.up(key);
  const capture = await stopMotionCapture(observedPage, captureId);
  expect(capture?.timedOut).toBe(false);
  expect(capture?.sampleCount ?? 0).toBeGreaterThan(8);
  return capture;
}

async function waitForPaddleSync(pageA, pageB, tolerance = 18) {
  await expect.poll(async () => {
    const [stateA, stateB] = await Promise.all([getTestState(pageA), getTestState(pageB)]);
    return Math.abs(stateA.playerY - stateB.playerY);
  }, { timeout: 15_000 }).toBeLessThanOrEqual(tolerance);
}

async function createStartedOnlineMatch(browser, {
  roomId = createShortRoomId('stg'),
  hostName = 'Stage Host',
  guestName = 'Stage Guest',
  pointsToWin = 3
} = {}) {
  const contextOne = await createIsolatedContext(browser);
  const contextTwo = await createIsolatedContext(browser);
  const hostPage = await contextOne.newPage();
  const guestPage = await contextTwo.newPage();

  await openOnlineLobby(hostPage, hostName);
  await hostPage.locator('#pointsToWin').fill(String(pointsToWin));
  await hostPage.locator('#roomId').fill(roomId);
  await hostPage.locator('#connectOnlineBtn').click();
  await expect.poll(async () => (await getTestState(hostPage)).connected, { timeout: 30_000 }).toBe(true);
  await hostPage.locator('#createRoomBtn').click();
  await expect.poll(async () => (await getTestState(hostPage)).roomId, { timeout: 30_000 }).toBe(roomId);

  await openOnlineLobby(guestPage, guestName);
  await guestPage.locator('#pointsToWin').fill(String(pointsToWin));
  await guestPage.locator('#connectOnlineBtn').click();
  await expect.poll(async () => (await getTestState(guestPage)).connected, { timeout: 30_000 }).toBe(true);
  await expect(guestPage.locator('#roomsList')).toContainText(roomId, { timeout: 30_000 });
  await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
  await expect(guestPage.locator('#roomId')).toHaveValue(roomId);
  await guestPage.locator('#joinRoomBtn').click();
  await expect.poll(async () => (await getTestState(guestPage)).roomId, { timeout: 30_000 }).toBe(roomId);

  await expect.poll(async () => (await getTestState(hostPage)).waiting, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await getTestState(hostPage)).isHost, { timeout: 15_000 }).toBe(true);
  await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
  await hostPage.locator('#startRoomBtn').click();

  await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
  await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
  await expect.poll(async () => (await getTestState(hostPage)).snapshotSeq, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await getTestState(guestPage)).snapshotSeq, { timeout: 15_000 }).toBeGreaterThan(0);

  return { contextOne, contextTwo, hostPage, guestPage, roomId };
}

test('measures staging lag against local two-player reference @staging', async ({ browser }) => {
  const localContext = await createIsolatedContext(browser);
  const localPage = await localContext.newPage();
  await openLocalTwoPlayerGame(localPage);

  const localMotion = await captureMotionWhileHolding({
    actionPage: localPage,
    observedPage: localPage,
    observedTarget: 'player',
    framesAfterResponse: 18
  });

  const { contextOne, contextTwo, hostPage, guestPage } = await createStartedOnlineMatch(browser, {
    roomId: createShortRoomId('lag')
  });
  await waitForPaddleSync(hostPage, guestPage);

  const onlineMotion = await captureMotionWhileHolding({
    actionPage: hostPage,
    observedPage: guestPage,
    observedTarget: 'player',
    framesAfterResponse: 18
  });

  console.log('staging-lag-metrics', JSON.stringify({
    localMotion,
    onlineMotion
  }));

  expect(onlineMotion.firstResponseMs).toBeLessThanOrEqual(localMotion.firstResponseMs + 260);
  expect(onlineMotion.maxJump).toBeLessThanOrEqual(Math.max(localMotion.maxJump + 24, 30));
  expect(onlineMotion.totalTravel).toBeGreaterThan(localMotion.totalTravel * 0.65);

  await localContext.close();
  await contextOne.close();
  await contextTwo.close();
});
