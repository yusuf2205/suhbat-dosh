#!/bin/sh
# Enables "sign in with e-mail" by storing a Resend API key (read without echo, kept in .env mode 600).
# Run on the NAS:  cd /home/Joseph/docker/suhbat && sh scripts/set-email-key.sh
set -e
cd "$(dirname "$0")/.."
printf 'Resend API key (starts with re_, input hidden): '
stty -echo 2>/dev/null || true
read -r KEY
stty echo 2>/dev/null || true
printf '\n'
case "$KEY" in
  re_*) ;;
  *) echo "That does not look like a Resend API key (expected re_...)."; exit 1 ;;
esac
touch .env && chmod 600 .env
grep -v -E '^(RESEND_API_KEY|EMAIL_FROM)=' .env > .env.tmp || true
{
  printf 'RESEND_API_KEY=%s\n' "$KEY"
  printf 'EMAIL_FROM=Suhbat-dosh <no-reply@suhbat-dosh.uz>\n'
} >> .env.tmp
mv .env.tmp .env && chmod 600 .env
docker compose -p suhbat up -d
sleep 6
echo "providers:"; curl -s http://127.0.0.1:3270/api/auth/providers; echo
