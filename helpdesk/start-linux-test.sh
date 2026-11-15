#!/bin/sh
# 🧪 מצב ניסיון על לינוקס: עובד על עותק של הנתונים, בלי למשוך הודעות מ-Green API ובלי לשלוח כלום –
# אפשר להריץ במקביל לשרת האמיתי בלי להפריע לו. נכנסים ב-http://<כתובת השרת>:8080
cd "$(dirname "$0")"
export HD_TEST_MODE=1
export HD_HOST=0.0.0.0
exec node server.js
