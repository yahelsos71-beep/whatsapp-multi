#!/bin/bash
# ============================================================
# מוקד וואטסאפ – יצירת לקוח חדש בפקודה אחת (על שרת לינוקס)
#
#   sh /opt/helpdesk/new-client.sh <שם-באנגלית> [כתובת-IP-של-המשרד-שלו] [דומיין]
#
# דוגמאות:
#   sh /opt/helpdesk/new-client.sh cohen 31.168.1.2
#       → מוקד נקי בפורט פנוי, פתוח רק לכתובת של המשרד של הלקוח
#   sh /opt/helpdesk/new-client.sh cohen 31.168.1.2 cohen.kc-grp.co.il
#       → כנ"ל + כתובת מאובטחת https://cohen.kc-grp.co.il (צריך להפנות את הדומיין לשרת קודם)
#
# כל לקוח מקבל: תיקייה משלו (/opt/clients/<שם>), נתונים משלו, פורט משלו,
# שירות קבוע שעולה לבד, ועדכונים אוטומטיים כמו המוקד הראשי.
# ============================================================
set -e
NAME="$1"; OFFICE_IP="$2"; DOMAIN="$3"
SRC="$(cd "$(dirname "$0")" && pwd)"
if ! echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]{1,30}$'; then
  echo "שימוש: sh new-client.sh <שם-באנגלית-קטנות> [IP-של-המשרד] [דומיין]"
  echo "למשל:  sh new-client.sh cohen 31.168.1.2"
  exit 1
fi
DIR="/opt/clients/$NAME"
SVC="helpdesk-$NAME"
if [ -e "$DIR" ]; then echo "❌ הלקוח $NAME כבר קיים ($DIR)"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "❌ צריך להריץ כ-root"; exit 1; fi

# פורט פנוי: מ-8081 והלאה (8080 = המוקד הראשי)
PORT=8081
while ss -ltn | grep -q ":$PORT " || grep -rqs "HD_PORT=$PORT$" /etc/systemd/system/helpdesk-*.service; do PORT=$((PORT+1)); done

echo "▶ יוצר את $NAME בתיקייה $DIR (פורט $PORT)..."
mkdir -p "$DIR"
# מעתיקים את הקוד – בלי הנתונים של KC, בלי גיבויים ובלי קבצי ווינדוס
tar -C "$SRC" --exclude=./data --exclude='./data-*' --exclude=./node --exclude='*.log' -cf - . | tar -C "$DIR" -xf -
mkdir -p "$DIR/data"

# אם יש דומיין – המוקד מאזין רק מקומית, והגישה היא דרך https (nginx)
if [ -n "$DOMAIN" ]; then LISTEN=127.0.0.1; else LISTEN=0.0.0.0; fi

cat > "/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=WhatsApp Helpdesk - $NAME
After=network-online.target
[Service]
WorkingDirectory=$DIR
Environment=HD_PORT=$PORT
Environment=HD_HOST=$LISTEN
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SVC" >/dev/null 2>&1
sleep 3
if ! systemctl is-active --quiet "$SVC"; then echo "❌ השירות לא עלה. פרטים: journalctl -u $SVC -n 30"; exit 1; fi

URL="http://$(curl -4 -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}'):$PORT"

if [ -z "$DOMAIN" ]; then
  if [ -n "$OFFICE_IP" ]; then
    ufw allow from "$OFFICE_IP" to any port "$PORT" proto tcp >/dev/null && echo "▶ הגישה פתוחה רק לכתובת $OFFICE_IP"
  else
    echo "⚠️ לא נפתחה גישה בחומת האש. לפתוח למשרד של הלקוח:"
    echo "   ufw allow from <IP-של-הלקוח> to any port $PORT proto tcp"
  fi
else
  # https עם nginx + תעודה חינמית (Let's Encrypt)
  if ss -ltnp | grep -E ':80 ' | grep -vq nginx; then
    echo "⚠️ פורט 80 תפוס ע\"י תוכנה אחרת (לא nginx) – לא הגדרתי https. המוקד עובד בינתיים רק מקומית בפורט $PORT."
  else
    command -v nginx >/dev/null || apt-get install -y nginx >/dev/null
    command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx >/dev/null
    cat > "/etc/nginx/sites-available/$SVC" <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 60m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
EOF
    ln -sf "/etc/nginx/sites-available/$SVC" "/etc/nginx/sites-enabled/$SVC"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
      URL="https://$DOMAIN"
    else
      URL="http://$DOMAIN"
      echo "⚠️ התעודה (https) לא הונפקה – בדוק שהדומיין $DOMAIN מופנה לכתובת של השרת, ואז הרץ:"
      echo "   certbot --nginx -d $DOMAIN"
    fi
  fi
fi

echo ""
echo "✅ הלקוח $NAME מוכן!"
echo "   כתובת:   $URL"
echo "   נכנסים בפעם הראשונה ויוצרים משתמש מנהל, ואז בניהול: מספרי וואטסאפ (Green API), עובדים, מחלקות, AI ומרכזייה."
echo "   ניהול:   systemctl status $SVC   |   עצירה: systemctl stop $SVC   |   יומן: journalctl -u $SVC -f"
