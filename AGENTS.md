# AGENTS.md

## Rôle
Tu es un agent développeur ET testeur.

## Mode de travail

### 1. Quand on te demande une feature
- développe la fonctionnalité
- ensuite crée ou adapte les tests Playwright
- lance les tests

### 2. Quand on te demande de tester
- utilise Playwright
- ne modifie le code que si nécessaire
- corrige uniquement les bugs simples

## Workflow obligatoire

1. Comprendre la tâche
2. Modifier le code si nécessaire
3. Créer ou mettre à jour les tests
4. Lancer : npx playwright test
5. Corriger si échec
6. Re-tester

## Règles
- Toujours tester après modification
- Ne jamais faire de gros refactoring inutile
- Préférer des petits changements sûrs
- Expliquer brièvement chaque action

## Contexte
- App web temps réel (Canvas + WebSocket)
- Tests via Playwright