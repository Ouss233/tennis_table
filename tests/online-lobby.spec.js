import { test, expect } from '@playwright/test';

function createMotionCaptureId(prefix = 'motion') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function openOnlineLobby(page, playerName) {
  await page.goto('/jeux_ping_pong.html');
  await page.locator('#gameMode').selectOption('online');
  await page.getByRole('button', { name: 'Lobby online' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby Online' })).toBeVisible();
  await expect(page.locator('#playerName')).toBeVisible();
  await page.locator('#playerName').fill(playerName);
  await page.locator('#serverUrl').fill('ws://127.0.0.1:8080');
}

async function getTestState(page) {
  return page.evaluate(() => window.__pongTestApi.getState());
}

async function getBackgroundStyle(page) {
  return page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage);
}

async function applyOnlinePowerUp(page, powerUpType, owner = 'p1') {
  await page.evaluate(({ nextType, nextOwner }) => {
    window.__pongTestApi.applyOnlinePowerUp(nextType, nextOwner);
  }, { nextType: powerUpType, nextOwner: owner });
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
  await page.evaluate(({ captureId: id, observedTarget, captureOptions }) => {
    window.__pongTestApi.startMotionCapture(id, observedTarget, captureOptions);
  }, { captureId, observedTarget: target, captureOptions: options });
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
  }).toBe(true);
  await actionPage.keyboard.up(key);
  const capture = await stopMotionCapture(observedPage, captureId);
  expect(capture?.timedOut).toBe(false);
  expect(capture?.sampleCount ?? 0).toBeGreaterThan(8);
  return capture;
}

async function waitForPaddleSync(pageA, pageB, tolerance = 14) {
  await expect.poll(async () => {
    const [stateA, stateB] = await Promise.all([getTestState(pageA), getTestState(pageB)]);
    return Math.abs(stateA.playerY - stateB.playerY);
  }).toBeLessThanOrEqual(tolerance);
}

async function createStartedOnlineMatch(browser, {
  roomId = `room-${Date.now()}`,
  hostName = 'Host Player',
  guestName = 'Guest Player',
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
  await expect(hostPage.locator('#connectionText')).toContainText('connecte au serveur');
  await hostPage.locator('#createRoomBtn').click();
  await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);

  await openOnlineLobby(guestPage, guestName);
  await guestPage.locator('#pointsToWin').fill(String(pointsToWin));
  await guestPage.locator('#connectOnlineBtn').click();
  await expect(guestPage.locator('#connectionText')).toContainText('connecte au serveur');
  await expect(guestPage.locator('#roomsList')).toContainText(roomId);
  await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
  await expect(guestPage.locator('#roomId')).toHaveValue(roomId);
  await guestPage.locator('#joinRoomBtn').click();
  await expect(guestPage.locator('#connectionText')).toContainText(`room ${roomId} rejointe`);

  await expect.poll(async () => (await getTestState(hostPage)).waiting).toBe(false);
  await expect.poll(async () => (await getTestState(hostPage)).isHost).toBe(true);
  await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
  await hostPage.locator('#startRoomBtn').click();

  await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
  await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
  await expect.poll(async () => (await getTestState(hostPage)).snapshotSeq).toBeGreaterThan(0);
  await expect.poll(async () => (await getTestState(guestPage)).snapshotSeq).toBeGreaterThan(0);

  return { contextOne, contextTwo, hostPage, guestPage, roomId };
}

test.describe('Online Lobby', () => {
  test('opens the online lobby dialog and connects directly from its connect button', async ({ page }) => {
    await page.goto('/jeux_ping_pong.html');
    await page.locator('#gameMode').selectOption('online');
    await page.getByRole('button', { name: 'Lobby online' }).click();
    await expect(page.getByRole('heading', { name: 'Lobby Online' })).toBeVisible();
    await page.locator('#playerName').fill('Direct Player');
    await page.locator('#serverUrl').fill('ws://127.0.0.1:8080');
    await page.locator('#connectOnlineBtn').click();

    await expect(page.locator('#connectionText')).toContainText('connecte au serveur');
    await expect(page.getByRole('heading', { name: 'Lobby Online' })).toBeVisible();
  });

  test('connects to the local websocket lobby', async ({ page }) => {
    await openOnlineLobby(page, 'Player Alpha');

    await page.locator('#connectOnlineBtn').click();

    await expect(page.locator('#connectionText')).toContainText('connecte au serveur');
    await expect(page.locator('#connectedUsersList')).toContainText('Player Alpha');
  });

  test('prevents joining a room until one is selected from the list', async ({ browser }) => {
    const roomId = `pick-${Date.now()}`;
    const contextOne = await createIsolatedContext(browser);
    const contextTwo = await createIsolatedContext(browser);
    const hostPage = await contextOne.newPage();
    const guestPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Picker Host');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await hostPage.locator('#createRoomBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);

    await openOnlineLobby(guestPage, 'Picker Guest');
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);
    await expect(guestPage.locator('#joinRoomBtn')).toBeDisabled();

    await guestPage.locator('#roomId').fill(roomId);
    await expect(guestPage.locator('#joinRoomBtn')).toBeDisabled();

    await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
    await expect(guestPage.locator('#joinRoomBtn')).toBeEnabled();

    await contextOne.close();
    await contextTwo.close();
  });

  test('rejects creating a room with an existing name', async ({ browser }) => {
    const roomId = `dup-${Date.now()}`;
    const contextOne = await createIsolatedContext(browser);
    const contextTwo = await createIsolatedContext(browser);
    const hostPage = await contextOne.newPage();
    const challengerPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Dup Host');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await hostPage.locator('#createRoomBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);

    await openOnlineLobby(challengerPage, 'Dup Challenger');
    await challengerPage.locator('#roomId').fill(roomId);
    await challengerPage.locator('#connectOnlineBtn').click();
    await challengerPage.locator('#createRoomBtn').click();

    await expect.poll(async () => (await getTestState(challengerPage)).statusText).toContain('Cette room existe deja');
    await expect.poll(async () => (await getTestState(challengerPage)).inRoom).toBe(false);

    await contextOne.close();
    await contextTwo.close();
  });

  test('prevents creating another room while already inside one', async ({ browser }) => {
    const roomId = `solo-${Date.now()}`;
    const context = await createIsolatedContext(browser);
    const page = await context.newPage();

    await openOnlineLobby(page, 'Busy Host');
    await page.locator('#roomId').fill(roomId);
    await page.locator('#connectOnlineBtn').click();
    await page.locator('#createRoomBtn').click();
    await expect(page.locator('#connectionText')).toContainText(`room ${roomId} creee`);

    await page.locator('#roomId').fill(`${roomId}-bis`);
    await expect(page.locator('#createRoomBtn')).toBeDisabled();
    await expect.poll(async () => (await getTestState(page)).roomId).toBe(roomId);

    await context.close();
  });

  test('keeps the illustrated background in online mode before and after game start', async ({ browser }) => {
    const roomId = `bg-${Date.now()}`;
    const contextOne = await createIsolatedContext(browser);
    const contextTwo = await createIsolatedContext(browser);
    const hostPage = await contextOne.newPage();
    const guestPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Background Host');
    expect(await getBackgroundStyle(hostPage)).toContain('radial-gradient');
    expect(await getBackgroundStyle(hostPage)).not.toContain('raw.githubusercontent');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText('connecte au serveur');
    await hostPage.locator('#createRoomBtn').click();

    await openOnlineLobby(guestPage, 'Background Guest');
    expect(await getBackgroundStyle(guestPage)).toContain('radial-gradient');
    expect(await getBackgroundStyle(guestPage)).not.toContain('raw.githubusercontent');
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);
    await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
    await expect(guestPage.locator('#roomId')).toHaveValue(roomId);
    await guestPage.locator('#joinRoomBtn').click();

    await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
    await hostPage.locator('#startRoomBtn').click();

    await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
    expect(await getBackgroundStyle(hostPage)).toContain('radial-gradient');
    expect(await getBackgroundStyle(guestPage)).toContain('radial-gradient');

    await contextOne.close();
    await contextTwo.close();
  });

  test('creates a room, joins with a second player, and starts the game', async ({ browser }) => {
    const { contextOne, contextTwo, hostPage, guestPage } = await createStartedOnlineMatch(browser);

    await expect(hostPage.locator('#leftPlayerBanner')).toContainText('Host Player');
    await expect(hostPage.locator('#rightPlayerBanner')).toContainText('Guest Player');
    await expect(guestPage.locator('#leftPlayerBanner')).toContainText('Host Player');
    await expect(guestPage.locator('#rightPlayerBanner')).toContainText('Guest Player');

    await expect.poll(async () => (await getTestState(hostPage)).obstacleCount).toBe(1);
    await expect.poll(async () => (await getTestState(guestPage)).obstacleCount).toBe(1);
    await waitForPaddleSync(hostPage, guestPage);

    const hostMotion = await captureMotionWhileHolding({
      actionPage: hostPage,
      observedPage: hostPage,
      key: 'w',
      observedTarget: 'player',
      framesAfterResponse: 14
    });
    const guestMotion = await captureMotionWhileHolding({
      actionPage: hostPage,
      observedPage: guestPage,
      key: 'w',
      observedTarget: 'player',
      framesAfterResponse: 14
    });

    await expect(hostPage.locator('#pauseBtn')).toBeVisible();
    await expect(guestPage.locator('#pauseBtn')).toBeVisible();
    await expect.poll(async () => (await getTestState(hostPage)).scoreText).toContain('Host Player');
    await expect.poll(async () => (await getTestState(guestPage)).scoreText).toContain('Guest Player');
    expect(hostMotion.totalTravel).toBeGreaterThan(18);
    expect(guestMotion.totalTravel).toBeGreaterThan(8);
    await expect.poll(async () => (await getTestState(hostPage)).ignoredSnapshotCount).toBe(0);
    await expect.poll(async () => (await getTestState(guestPage)).ignoredSnapshotCount).toBe(0);

    await contextOne.close();
    await contextTwo.close();
  });

  test('completes a stable two-player socket journey across lobby buttons, in-game controls, bonuses, and launch readiness', async ({ browser }) => {
    const localContext = await createIsolatedContext(browser);
    const localPage = await localContext.newPage();
    await openLocalTwoPlayerGame(localPage);
    const localMotion = await captureMotionWhileHolding({
      actionPage: localPage,
      observedPage: localPage,
      observedTarget: 'player',
      framesAfterResponse: 18
    });

    const hostContext = await createIsolatedContext(browser);
    const guestContext = await createIsolatedContext(browser);
    const spectatorContext = await createIsolatedContext(browser);
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();
    const spectatorPage = await spectatorContext.newPage();
    const roomId = `full-${Date.now()}`;

    await openOnlineLobby(hostPage, 'Full Host');
    await expect(hostPage.locator('#connectOnlineBtn')).toBeEnabled();
    await expect(hostPage.locator('#createRoomBtn')).toBeDisabled();
    await expect(hostPage.locator('#joinRoomBtn')).toBeDisabled();
    await expect(hostPage.locator('#startRoomBtn')).toBeDisabled();

    await hostPage.locator('#pointsToWin').fill('3');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await expect(hostPage.locator('#createRoomBtn')).toBeEnabled();
    await expect(hostPage.locator('#joinRoomBtn')).toBeDisabled();
    await hostPage.locator('#createRoomBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);
    await expect(hostPage.locator('#startRoomBtn')).toBeDisabled();

    await openOnlineLobby(guestPage, 'Full Guest');
    await expect(guestPage.locator('#connectOnlineBtn')).toBeEnabled();
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#joinRoomBtn')).toBeDisabled();
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);
    await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
    await expect(guestPage.locator('#joinRoomBtn')).toBeEnabled();
    await guestPage.locator('#joinRoomBtn').click();
    await expect(guestPage.locator('#connectionText')).toContainText(`room ${roomId} rejointe`);

    const hostStateAfterJoin = await getTestState(hostPage);
    await expect.poll(async () => (await getTestState(hostPage)).waiting).toBe(false);
    await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();

    await openOnlineLobby(spectatorPage, 'Lobby Watcher');
    await spectatorPage.locator('#connectOnlineBtn').click();
    await expect(spectatorPage.locator('#connectionText')).toContainText('connecte au serveur');
    await expect.poll(async () => (await getTestState(hostPage)).lobbySeq).toBeGreaterThan(hostStateAfterJoin.lobbySeq);
    await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();

    await hostPage.locator('#startRoomBtn').click();

    await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(hostPage.locator('#pauseBtn')).toBeVisible();
    await expect(hostPage.locator('#menuToggleBtn')).toBeVisible();
    await expect(guestPage.locator('#pauseBtn')).toBeVisible();
    await expect.poll(async () => (await getTestState(hostPage)).obstacleCount).toBe(1);
    await expect.poll(async () => (await getTestState(guestPage)).obstacleCount).toBe(1);

    await hostPage.locator('#pauseBtn').click();
    await expect.poll(async () => (await getTestState(hostPage)).paused).toBe(true);
    await expect.poll(async () => (await getTestState(guestPage)).paused).toBe(true);
    await hostPage.locator('#pauseBtn').click();
    await expect.poll(async () => (await getTestState(hostPage)).paused).toBe(false);
    await expect.poll(async () => (await getTestState(guestPage)).paused).toBe(false);

    await hostPage.locator('#menuToggleBtn').click();
    await expect.poll(async () => (await getTestState(hostPage)).menuOpen).toBe(true);
    await expect(hostPage.locator('#resumeGameBtn')).toBeVisible();
    await hostPage.locator('#resumeGameBtn').click();
    await expect.poll(async () => (await getTestState(hostPage)).menuOpen).toBe(false);

    await applyOnlinePowerUp(hostPage, 'expand', 'p1');
    await expect.poll(async () => (await getTestState(hostPage)).activeBonusCount).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await getTestState(guestPage)).activeBonusCount).toBeGreaterThanOrEqual(1);
    await expect(hostPage.locator('#leftBonusEffects')).toContainText('Raquette +');
    await expect(guestPage.locator('#leftBonusEffects')).toContainText('Raquette +');

    await applyOnlinePowerUp(hostPage, 'paddleSpeed', 'p2');
    await expect.poll(async () => (await getTestState(hostPage)).activeBonusCount).toBeGreaterThanOrEqual(2);
    await expect(hostPage.locator('#rightBonusEffects')).toContainText('Raquette rapide');
    await expect(guestPage.locator('#rightBonusEffects')).toContainText('Raquette rapide');

    await applyOnlinePowerUp(hostPage, 'duplicate', 'p1');
    await expect.poll(async () => (await getTestState(hostPage)).ballCount).toBe(2);
    await expect.poll(async () => (await getTestState(guestPage)).ballCount).toBe(2);

    await waitForPaddleSync(hostPage, guestPage);
    const onlineMotion = await captureMotionWhileHolding({
      actionPage: hostPage,
      observedPage: guestPage
    });
    expect(onlineMotion.firstResponseMs).toBeLessThanOrEqual(localMotion.firstResponseMs + 160);
    expect(onlineMotion.maxJump).toBeLessThanOrEqual(Math.max(localMotion.maxJump + 18, 26));
    expect(onlineMotion.totalTravel).toBeGreaterThan(localMotion.totalTravel * 0.7);

    await hostPage.evaluate(() => window.__pongTestApi.forceOnlineWinner('p1'));
    await expect(hostPage.locator('#overlayReplayOnline')).toBeVisible();
    await expect(hostPage.locator('#overlayMenuBtn')).toBeVisible();
    await hostPage.locator('#overlayReplayOnline').click();
    await expect.poll(async () => (await getTestState(hostPage)).running).toBe(true);
    await expect.poll(async () => (await getTestState(guestPage)).onlineWinner).toBe(null);

    await localContext.close();
    await hostContext.close();
    await guestContext.close();
    await spectatorContext.close();
  });

  test('opens the in-game menu in socket mode and pauses then resumes for both players', async ({ browser }) => {
    const { contextOne, contextTwo, hostPage, guestPage } = await createStartedOnlineMatch(browser, {
      roomId: `pause-${Date.now()}`
    });

    await expect(hostPage.locator('#menuToggleBtn')).toBeVisible();
    await expect(hostPage.locator('#pauseBtn')).toBeVisible();
    await hostPage.locator('#menuToggleBtn').click();

    await expect.poll(async () => (await getTestState(hostPage)).menuOpen).toBe(true);
    await expect.poll(async () => (await getTestState(hostPage)).paused).toBe(true);
    await expect.poll(async () => (await getTestState(guestPage)).paused).toBe(true);
    await expect(hostPage.locator('#resumeGameBtn')).toBeVisible();
    await expect(hostPage.locator('#pauseBtn')).toContainText('Reprendre');

    await hostPage.locator('#resumeGameBtn').click();

    await expect.poll(async () => (await getTestState(hostPage)).menuOpen).toBe(false);
    await expect.poll(async () => (await getTestState(hostPage)).paused).toBe(false);
    await expect.poll(async () => (await getTestState(guestPage)).paused).toBe(false);
    await expect(hostPage.locator('#pauseBtn')).toContainText('Pause');

    await contextOne.close();
    await contextTwo.close();
  });

  test('shows replay controls at the end of a socket match and lets the host restart', async ({ browser }) => {
    const { contextOne, contextTwo, hostPage, guestPage } = await createStartedOnlineMatch(browser, {
      roomId: `replay-${Date.now()}`,
      pointsToWin: 1
    });

    await expect.poll(async () => (await getTestState(hostPage)).running).toBe(true);
    await hostPage.evaluate(() => window.__pongTestApi.forceOnlineWinner('p1'));

    await expect(hostPage.locator('#overlayReplayOnline')).toBeVisible();
    await expect(hostPage.locator('#overlayBox .winnerTitle')).toContainText('Host Player a gagne');
    await expect(guestPage.locator('#overlayReplayOnline')).toBeDisabled();
    await expect.poll(async () => (await getTestState(hostPage)).onlineWinner).toBe('p1');
    await expect.poll(async () => (await getTestState(guestPage)).onlineWinner).toBe('p1');
    await expect(hostPage.locator('#overlayReplayOnline')).toHaveClass(/menuAction/);
    await expect(hostPage.locator('#overlayMenuBtn')).toHaveClass(/menuAction/);

    await hostPage.locator('#overlayReplayOnline').click();

    await expect(hostPage.locator('#overlay')).not.toHaveClass(/overlayVisible/);
    await expect.poll(async () => (await getTestState(hostPage)).playing).toBe(true);
    await expect.poll(async () => (await getTestState(hostPage)).running).toBe(true);
    await expect.poll(async () => (await getTestState(hostPage)).onlineWinner).toBe(null);
    await expect.poll(async () => (await getTestState(guestPage)).onlineWinner).toBe(null);
    await expect(hostPage.locator('#scoreLabel')).toContainText('0');
    await expect(guestPage.locator('#scoreLabel')).toContainText('0');

    await hostPage.evaluate(() => window.__pongTestApi.forceOnlineWinner('p1'));
    await expect(hostPage.locator('#overlayMenuBtn')).toBeVisible();
    await hostPage.locator('#overlayMenuBtn').click();

    await expect(hostPage.locator('#gameContainer')).not.toHaveClass(/playing/);
    await expect(hostPage.getByRole('button', { name: 'Lobby online' })).toBeVisible();

    await contextOne.close();
    await contextTwo.close();
  });

  test('keeps remote two-player movement responsive and smooth compared with local play', async ({ browser }) => {
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
      roomId: `motion-${Date.now()}`
    });
    await waitForPaddleSync(hostPage, guestPage);

    const onlineMotion = await captureMotionWhileHolding({
      actionPage: hostPage,
      observedPage: guestPage
    });

    expect(onlineMotion.firstResponseMs).toBeLessThanOrEqual(localMotion.firstResponseMs + 160);
    expect(onlineMotion.maxJump).toBeLessThanOrEqual(Math.max(localMotion.maxJump + 18, 26));
    expect(onlineMotion.totalTravel).toBeGreaterThan(localMotion.totalTravel * 0.7);
    await expect.poll(async () => (await getTestState(guestPage)).ignoredSnapshotCount).toBe(0);

    await localContext.close();
    await contextOne.close();
    await contextTwo.close();
  });

  test('selecting an available room does not auto-join it', async ({ browser }) => {
    const roomId = `sel-${Date.now()}`;
    const contextOne = await createIsolatedContext(browser);
    const contextTwo = await createIsolatedContext(browser);
    const hostPage = await contextOne.newPage();
    const guestPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Select Host');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText('connecte au serveur');
    await hostPage.locator('#createRoomBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);

    await openOnlineLobby(guestPage, 'Select Guest');
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);

    await guestPage.locator('#roomsList .lobbyItem').filter({ hasText: roomId }).click();
    await expect(guestPage.locator('#roomId')).toHaveValue(roomId);
    await expect(guestPage.locator('#joinRoomBtn')).toBeEnabled();
    await expect(guestPage.locator('#connectionText')).toContainText('connecte au serveur');

    const guestState = await getTestState(guestPage);
    expect(guestState.inRoom).toBe(false);

    await contextOne.close();
    await contextTwo.close();
  });
});
