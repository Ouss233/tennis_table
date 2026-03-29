import { test, expect } from '@playwright/test';

async function openGame(page) {
  await page.goto('/');
  await expect(page).toHaveURL(/jeux_ping_pong\.html$/);
  await expect(page.getByRole('heading', { name: 'Tennis Table' })).toBeVisible();
}

test.describe('Smoke and Main Navigation', () => {
  test('opens the application and shows the main actions', async ({ page }) => {
    await openGame(page);

    await expect(page.getByRole('button', { name: 'Jouer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'High Score' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Règles' })).toBeVisible();
    await expect(page.locator('#gameMode')).toHaveValue('single');
  });

  test('opens and closes the rules modal', async ({ page }) => {
    await openGame(page);

    await page.getByRole('button', { name: 'Règles' }).click();
    await expect(page.getByRole('heading', { name: 'Règles du jeu' })).toBeVisible();
    await expect(page.getByText(/Le but est d’envoyer la balle/i)).toBeVisible();
    await page.getByRole('button', { name: 'Fermer' }).click();
    await expect(page.getByRole('heading', { name: 'Règles du jeu' })).toBeHidden();
  });

  test('opens and closes the high score modal', async ({ page }) => {
    await openGame(page);

    await page.getByRole('button', { name: 'High Score' }).click();
    await expect(page.getByRole('heading', { name: 'High Score' })).toBeVisible();
    await page.locator('#closeHighScoreModal').click();
    await expect(page.getByRole('heading', { name: 'High Score' })).toBeHidden();
  });

  test('switches to two-player mode and updates the score label after start', async ({ page }) => {
    await openGame(page);

    await page.locator('#gameMode').selectOption('two');
    await page.getByRole('button', { name: 'Jouer' }).click();

    await expect(page.locator('#scoreLabel')).toContainText('P1');
    await expect(page.locator('#scoreLabel')).toContainText('P2');
  });
});
