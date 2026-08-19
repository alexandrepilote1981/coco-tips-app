#!/bin/bash
# Prépare une session Claude Code sur le web : installe les dépendances et repère un
# navigateur pour les tests d'interface, afin que `npm test` fonctionne immédiatement.
#
# Sans ça, chaque session commence par découvrir que node_modules est vide et que le
# serveur refuse de démarrer sur « Cannot find module 'express' ».
set -euo pipefail

# En local, les dépendances sont déjà là et l'environnement appartient au développeur.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm install plutôt que npm ci : l'état du conteneur est mis en cache après le hook, et
# install réutilise ce qui est déjà présent au lieu de tout retélécharger à chaque fois.
npm install --no-audit --no-fund

# Les tests d'interface (test/ui-smoke.test.mjs) pilotent un vrai navigateur. Il est
# préinstallé dans l'environnement web ; on le nomme explicitement pour que le test ne
# dépende pas de l'ordre de recherche dans le PATH. S'il n'existe pas, le test se saute
# tout seul plutôt que d'échouer.
for chrome in /opt/pw-browsers/chromium "$(command -v chromium || true)" "$(command -v google-chrome || true)"; do
  if [ -n "$chrome" ] && [ -x "$chrome" ]; then
    echo "export CHROME_PATH=\"$chrome\"" >> "$CLAUDE_ENV_FILE"
    break
  fi
done
