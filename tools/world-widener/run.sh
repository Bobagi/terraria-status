#!/bin/bash
# Scratch tModLoader server for the widen job. No published port, copy of the data.
# usage: run.sh <worldname> [extra docker -e args...]
set -e
name="$1"; shift
docker rm -f ww-server >/dev/null 2>&1 || true
docker run -d --name ww-server -t -i \
  -v /opt/terraria-widen/data:/data -v /opt/terraria-widen/io:/io \
  -e TMOD_WORLDNAME="$name" -e TMOD_WORLDSIZE=1 -e TMOD_DIFFICULTY=1 -e TMOD_MAXPLAYERS=1 \
  -e TMOD_PORT=7777 -e TMOD_AUTOSAVE_INTERVAL=600 -e TMOD_PASS="ww-$(openssl rand -hex 8)" \
  -e TMOD_AUTODOWNLOAD="" \
  -e TMOD_ENABLEDMODS="2619954303,2563309347,2669644269,2687866031,2599842771,2565639705,2908170107,3021379176,2570931073,3222493606,2815540735,9000000001,9000000002" \
  "$@" --memory 4g --memory-swap 6g tmodloader-libicu:latest
