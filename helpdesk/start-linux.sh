#!/bin/sh
# מוקד וואטסאפ – הפעלה על לינוקס (השרת האמיתי). דורש Node.js 20 ומעלה.
cd "$(dirname "$0")"
while true; do
  node server.js
  code=$?
  [ "$code" -eq 10 ] && echo "The helpdesk server is already running." && exit 0
  echo "Server stopped (code $code) - restarting in 3 seconds..."
  sleep 3
done
