#!/bin/sh
# 🧪 מצב ניסיון על לינוקס: עובד על עותק של הנתונים, בלי למשוך הודעות מ-Green API ובלי לשלוח כלום –
# אפשר להריץ במקביל לשרת האמיתי בלי להפריע לו. נכנסים ב-http://<כתובת השרת>:8080
cd "$(dirname "$0")"
export HD_TEST_MODE=1
export HD_HOST=0.0.0.0
while true; do
  node server.js
  code=$?
  [ "$code" -eq 10 ] && echo "Already running." && exit 0
  echo "Restarting (code $code)..."
  sleep 3
done
