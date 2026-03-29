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

test.describe('Online Lobby', () => {
  test('connects to the local websocket lobby', async ({ page }) => {
    await openOnlineLobby(page, 'Player Alpha');

    await page.locator('#connectOnlineBtn').click();

    await expect(page.locator('#connectionText')).toContainText('connecte au serveur');
    await expect(page.locator('#connectedUsersList')).toContainText('Player Alpha');
  });

  test('creates a room, joins with a second player, and starts the game', async ({ browser }) => {
    const roomId = `room-${Date.now()}`;
    const contextOne = await browser.newContext();
    const contextTwo = await browser.newContext();
    const hostPage = await contextOne.newPage();
    const guestPage = await contextTwo.newPage();

    await openOnlineLobby(hostPage, 'Host Player');
    await hostPage.locator('#roomId').fill(roomId);
    await hostPage.locator('#connectOnlineBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText('connecte au serveur');
    await hostPage.locator('#createRoomBtn').click();
    await expect(hostPage.locator('#connectionText')).toContainText(`room ${roomId} creee`);
    await expect(hostPage.locator('#startRoomBtn')).toBeDisabled();

    await openOnlineLobby(guestPage, 'Guest Player');
    await guestPage.locator('#connectOnlineBtn').click();
    await expect(guestPage.locator('#connectionText')).toContainText('connecte au serveur');
    await expect(guestPage.locator('#roomsList')).toContainText(roomId);
    await guestPage.locator('#roomId').fill(roomId);
    await guestPage.locator('#joinRoomBtn').click();
    await expect(guestPage.locator('#connectionText')).toContainText(`room ${roomId} rejointe`);

    await expect(hostPage.locator('#startRoomBtn')).toBeEnabled();
    await hostPage.locator('#startRoomBtn').click();

    await expect(hostPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(guestPage.locator('#gameContainer')).toHaveClass(/playing/);
    await expect(hostPage.locator('#leftPlayerBanner')).toContainText('Host Player');
    await expect(hostPage.locator('#rightPlayerBanner')).toContainText('Guest Player');
    await expect(guestPage.locator('#leftPlayerBanner')).toContainText('Host Player');
    await expect(guestPage.locator('#rightPlayerBanner')).toContainText('Guest Player');

    await contextOne.close();
    await contextTwo.close();
  });
});
