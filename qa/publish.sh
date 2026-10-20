#!/usr/bin/env bash
# Публикация результатов в ветку qa-results. Сайт (gh-pages) не изменяется.
# Структура qa-results:
#   latest/      — результаты последней проверки (отчёт, снимки, листы, отличия, снимки ошибок)
#   reference/   — снимки последней УСПЕШНОЙ проверки (только для сравнения, не выдаётся за актуальный)
#   baseline/    — эталон: фиксируется пометкой [qa:baseline] в описании коммита gh-pages
#   history/     — отчёты 10 предыдущих проверок (без снимков)
#   access-test/ — первый тест доступа (оставлен без изменений)
set -euo pipefail
OUT=qa/out; PREV=prev; NEW=$(mktemp -d)
REMOTE="${QA_REMOTE:-https://github.com/${REPO}}"                                          # откуда читать состояние веток
PUSH_URL="${QA_PUSH_URL:-https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git}"   # куда публиковать
is_current() { [ "$(git ls-remote "$REMOTE" refs/heads/gh-pages | cut -f1)" = "$SITE_SHA" ]; }
PREV_SHA=$(git -C "$PREV" rev-parse HEAD 2>/dev/null || true)   # состояние qa-results, на которое опирается этот запуск

if python3 -c "import json,sys; f=json.load(open('qa/freshness.json')); sys.exit(0 if f.get('superseded') else 1)" 2>/dev/null; then
  echo "Опубликована более новая версия — результаты этого запуска не публикуются."; exit 0
fi
if ! is_current; then echo "В gh-pages уже более новый коммит — результаты этого запуска не публикуются."; exit 0; fi

for d in baseline access-test history reference; do [ -d "$PREV/$d" ] && cp -r "$PREV/$d" "$NEW/"; done
mkdir -p "$NEW/history" "$NEW/reference"

# предыдущий отчёт — в историю
if [ -f "$PREV/latest/summary.json" ]; then
  id=$(python3 -c "import json; d=json.load(open('$PREV/latest/summary.json')); print((d.get('run_at','unknown')[:19].replace(':','').replace('-','').replace('T','-'))+'-'+d['site']['sha'][:7])")
  mkdir -p "$NEW/history/$id"; cp "$PREV/latest/report.md" "$PREV/latest/summary.json" "$NEW/history/$id/" 2>/dev/null || true
fi
ls -1 "$NEW/history" | sort | head -n -10 | while read -r old; do rm -rf "$NEW/history/$old"; done

cp -r "$OUT" "$NEW/latest"

STATUS=$(python3 -c "import json; print(json.load(open('$OUT/summary.json'))['status'])")
MODE=$(python3 -c "import json; print(json.load(open('$OUT/summary.json'))['mode'])")

# опорные снимки обновляются только после успешной проверки; снимки ошибочной версии остаются только в latest/
if [ "$STATUS" = "PASSED" ] && [ -d "$OUT/shots" ]; then cp "$OUT"/shots/*.png "$NEW/reference/" 2>/dev/null || true; echo "$SITE_SHA" > "$NEW/reference/LAST_SHA"; fi

# эталон: только по явной пометке и только после успешной полной проверки
if [[ "${COMMIT_MSG:-}" == *"[qa:baseline]"* && "$STATUS" == "PASSED" && "$MODE" == "full" ]]; then
  rm -rf "$NEW/baseline"; mkdir -p "$NEW/baseline"; cp "$OUT"/shots/*.png "$NEW/baseline/"
  printf "Эталон зафиксирован %s по коммиту gh-pages %s\n" "$(date -u +%F\ %T)" "$SITE_SHA" > "$NEW/baseline/INFO.txt"
fi

RAW="https://raw.githubusercontent.com/${REPO}/qa-results"
cat > "$NEW/README.md" <<EOF
# qa-results — автоматическая проверка Digital Store

Служебная ветка. Заполняется автоматически после каждого обновления \`gh-pages\`. Сайт эта ветка не меняет.

- **Отчёт последней проверки:** ${RAW}/latest/report.md
- Сводка для программ: ${RAW}/latest/summary.json
- Сводные листы: папка \`latest/sheets\`; отдельные снимки: \`latest/shots\`; снимки ошибок: \`latest/failures\`; отличия: \`latest/diff\`
- Эталон: папка \`baseline\` (обновляется только пометкой \`[qa:baseline]\`)
- История отчётов: папка \`history\` (последние 10)

Последняя проверка: коммит сайта \`${SITE_SHA:0:7}\`, итог: ${STATUS}, режим: ${MODE}.
EOF

cd "$NEW"
git init -q -b qa-results
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "QA ${STATUS} (${MODE}) for gh-pages ${SITE_SHA:0:7}"
# непосредственно перед публикацией: коммит всё ещё актуален?
if ! is_current; then echo "Пока шла проверка, в gh-pages появился более новый коммит — результаты не публикуются."; exit 0; fi
# публикация только если qa-results не изменился с момента загрузки (иначе его уже обновил другой запуск)
if git push -q --force-with-lease="qa-results:${PREV_SHA}" "$PUSH_URL" HEAD:qa-results; then echo "Опубликовано в qa-results"; exit 0; fi
if ! is_current; then echo "Более новый запуск уже опубликовал результаты — этот запуск их не меняет."; exit 0; fi
echo "Не удалось опубликовать результаты"; exit 1
