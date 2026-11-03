#!/bin/bash
# Builds WorldWidener.tmod with the server's own tModLoader and installs it in the scratch data.
set -e
docker rm -f ww-build >/dev/null 2>&1 || true
docker run -d --name ww-build --entrypoint sleep -v /opt/terraria-widen/WorldWidener:/src:ro -v /opt/terraria-widen/sdk:/tmp/sdk tmodloader-libicu:latest infinity >/dev/null
docker exec ww-build sh -c 'mkdir -p /terraria-server/ModSources && cp -r /src /terraria-server/ModSources/WorldWidener && cd /terraria-server/ModSources/WorldWidener && PATH=/tmp/sdk:$PATH HOME=/tmp DOTNET_CLI_TELEMETRY_OPTOUT=1 dotnet build -c Release 2>&1 | grep -E " error |Build succeeded|Build FAILED"'
docker cp ww-build:/tmp/.local/share/Terraria/tModLoader/Mods/WorldWidener.tmod /opt/terraria-widen/data/steamMods/steamapps/workshop/content/1281930/9000000002/2026.05/
docker rm -f ww-build >/dev/null
