import { test, expect } from '@playwright/test';

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

async function openLocalTwoPlayerGame(page) {
  await page.goto('/jeux_ping_pong.html');
  await page.locator('#gameMode').selectOption('two');
  await page.getByRole('button', { name: 'Jouer' }).click();
  await expect(page.locator('#gameContainer')).toHaveClass(/playing/);
}

async function recordMotionSamples(page, key, durationMs = 420, sampleIntervalMs = 35) {
  const samples = [];
  const startedAt = Date.now();
  while ((Date.now() - startedAt) <= durationMs) {
    const state = await getTestState(page);
    samples.push({
      elapsedMs: Date.now() - startedAt,
      playerY: state.playerY
    });
    await page.waitForTimeout(sampleIntervalMs);
  }
  return samples;
}

function analyzeMotion(samples) {
  const origin = samples[0]?.playerY ?? 0;
  let firstResponseMs = null;
  let maxJump = 0;
  let totalTravel = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const delta = Math.abs(current.playerY - previous.playerY);
    maxJump = Math.max(maxJump, delta);
    totalTravel = Math.max(totalTravel, Math.abs(current.playerY - origin));
    if (firstResponseMs === null && Math.abs(current.playerY - origin) >= 3) {
      firstResponseMs = current.elapsedMs;
    }
  }
  return {
    firstResponseMs: firstResponseMs ?? Number.POSITIVE_INFINITY,
    maxJump,
    totalTravel
  };
}

async function captureMotionWhileHolding({ actionPage, observedPage, key = 'w', durationMs = 420 }) {
  await actionPage.locator('#game').click();
  const samplingPromise = recordMotionSamples(observedPage, key, durationMs + 260);
  await actionPage.keyboard.down(key);
  await actionPage.waitForTimeout(durationMs);
  await actionPage.keyboard.up(key);
  return analyzeMotion(await samplingPromise);
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
  const contextOne = await browser.newContext();
  const contextTwo = await browser.newContext();
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
  await guestPage.locator('#roomId').fill(roomId);
  await guestPage.locator('#joinRoomBtn').click();
  await expect(guestPage.locator('#connectionText')).toContainText(`room ${roomId} rejointe`);

  await expect.poll(async () => (await getTestState(hostPage)).waiting).toBe(false);
  await expect.poll(async () => (await getTestState(hostPage)).isHost).toBe(true);
  await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
  await hostPage.locator('#startRoomBtn').click();

  await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
  await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);

  return { contextOne, contextTwo, hostPage, guestPage, roomId };
}

test.describe('Online Lobby', () => {
  test('connects to the local websocket lobby', async ({ page }) => {
    await openOnlineLobby(page, 'Player Alpha');

    await page.locator('#connectOnlineBtn').click();

    await expect(page.locator('#connectionText')).toContainText('connecte au serveur');
    await expect(page.locator('#connectedUsersList')).toContainText('Player Alpha');
  });

  test('keeps the illustrated background in online mode before and after game start', async ({ browser }) => {
    const roomId = `bg-${Date.now()}`;
    const contextOne = await browser.newContext();
    const contextTwo = await browser.newContext();
    const hostPage = await contextOne.newPage();
    const guestPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Background Host');
    expect(await getBackgroundStyle(hostPage)).toContain('tabletennis43.jpg');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText('connecte au serveur');
    await hostPage.locator('#createRoomBtn').click();

    await openOnlineLobby(guestPage, 'Background Guest');
    expect(await getBackgroundStyle(guestPage)).toContain('tabletennis43.jpg');
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);
    await guestPage.locator('#roomId').fill(roomId);
    await guestPage.locator('#joinRoomBtn').click();

    await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
    await hostPage.locator('#startRoomBtn').click();

    await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
    expect(await getBackgroundStyle(hostPage)).toContain('tabletennis43.jpg');
    expect(await getBackgroundStyle(guestPage)).toContain('tabletennis43.jpg');

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

    const initialHostState = await getTestState(hostPage);
    const initialGuestState = await getTestState(guestPage);

    await hostPage.locator('#game').click();
    await hostPage.keyboard.down('w');
    await hostPage.waitForTimeout(350);
    await hostPage.keyboard.up('w');

    await expect.poll(async () => (await getTestState(hostPage)).playerY).not.toBe(initialHostState.playerY);
    await expect.poll(async () => (await getTestState(guestPage)).playerY).not.toBe(initialGuestState.playerY);

    await expect(hostPage.locator('#pauseBtn')).toBeVisible();
    await expect(guestPage.locator('#pauseBtn')).toBeVisible();
    await expect.poll(async () => (await getTestState(hostPage)).scoreText).toContain('Host Player');
    await expect.poll(async () => (await getTestState(guestPage)).scoreText).toContain('Guest Player');

    await contextOne.close();
    await contextTwo.close();
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

    await hostPage.evaluate(() => window.__pongTestApi.requestOnlineReplay());

    await expect.poll(async () => (await getTestState(hostPage)).running).toBe(true);
    await expect.poll(async () => (await getTestState(hostPage)).onlineWinner).toBe(null);
    await expect.poll(async () => (await getTestState(guestPage)).onlineWinner).toBe(null);
    await expect(hostPage.locator('#scoreLabel')).toContainText('0');
    await expect(guestPage.locator('#scoreLabel')).toContainText('0');

    await contextOne.close();
    await contextTwo.close();
  });

  test('keeps remote two-player movement responsive and smooth compared with local play', async ({ browser }) => {
    const localContext = await browser.newContext();
    const localPage = await localContext.newPage();
    await openLocalTwoPlayerGame(localPage);

    const localMotion = await captureMotionWhileHolding({
      actionPage: localPage,
      observedPage: localPage
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

    await localContext.close();
    await contextOne.close();
    await contextTwo.close();
  });

  test('selecting an available room does not auto-join it', async ({ browser }) => {
    const roomId = `sel-${Date.now()}`;
    const contextOne = await browser.newContext();
    const contextTwo = await browser.newContext();
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
