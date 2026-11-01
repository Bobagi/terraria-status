#!/usr/bin/env bash
# Runs one command on the tModLoader server console and prints its reply.
#   tools/tmod-admin.sh "give Bobagi Terra_Blade"
#   tools/tmod-admin.sh "coins Bobagi 10"
# Commands live in character-stats-mod/AdminCommands.cs. Vanilla ones work too
# (say, save, dawn, noon, dusk, midnight, playing, kick, settle).
set -euo pipefail
CONTAINER="${TMOD_CONTAINER:-tmodloader}"
[[ $# -eq 1 && -n "$1" ]] || { echo "uso: $0 \"<comando>\"" >&2; exit 2; }

# Marks where this command's reply starts: the console keeps older output.
before=$(docker exec "$CONTAINER" tmux capture-pane -p -S - | wc -l)
docker exec "$CONTAINER" inject "$1"
sleep "${TMOD_ADMIN_WAIT:-1}"
docker exec "$CONTAINER" tmux capture-pane -p -S - \
  | tail -n +"$((before > 24 ? before - 24 : 1))" \
  | awk -v cmd="$1" '$0 == cmd { buf = ""; found = 1; next } found { buf = buf $0 "\n" } END { printf "%s", buf }' \
  | sed -E 's/^: //; s/\b[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]+)?\b/<ip>/g' \
  | sed -e '/^$/d'
