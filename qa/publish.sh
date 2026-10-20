#!/usr/bin/env bash
# Публикация результатов в ветку qa-results. Сайт (gh-pages) не изменяется.
# Структура qa-results:
#   latest/      — результаты последней проверки (отчёт, снимки, листы, отличия, снимки ошибок)
#   reference/   — последний снимок каждого состояния (только для сравнения, не выдаётся за актуальный)
#   baseline/    — эталон: фиксируется пометкой [qa:baseline] в описании коммита gh-pages
#   history/     — отчёты 10 предыдущих проверок (без снимков)
#   access-test/ — первый тест доступа (оставлен без изменений)
set -euo pipefail
OUT=qa/out; PREV=prev; NEW=$(mktemp -d)

if python3 -c "import json,sys; f=json.load(open('qa/freshness.json')); sys.exit(0 if f.get('superseded') else 1)" 2>/dev/null; then
  echo "Опубликована более новая версия — результаты этого запуска не публикуются."; exit 0
fi

for d in baseline access-test history reference; do [ -d "$PREV/$d" ] && cp -r "$PREV/$d" "$NEW/"; done
mkdir -p "$NEW/history" "$NEW/reference"

# предыдущий отчёт — в историю
if [ -f "$PREV/latest/summary.json" ]; then
  id=$(python3 -c "import json; d=json.load(open('$PREV/latest/summary.json')); print((d.get('run_at','unknown')[:19].replace(':','').replace('-','').replace('T','-'))+'-'+d['site']['sha'][:7])")
  mkdir -p "$NEW/history/$id"; cp "$PREV/latest/report.md" "$PREV/latest/summary.json" "$NEW/history/$id/" 2>/dev/null || true
fi
ls -1 "$NEW/history" | sort | head -n -10 | while read -r old; do rm -rf "$NEW/history/$old"; done

cp -r "$OUT" "$NEW/latest"

# снимки текущей проверки становятся опорными для следующего сравнения
if [ -d "$OUT/shots" ]; then cp "$OUT"/shots/*.png "$NEW/reference/" 2>/dev/null || true; echo "$SITE_SHA" > "$NEW/reference/LAST_SHA"; fi

# эталон: только по явной пометке и только после успешной полной проверки
STATUS=$(python3 -c "import json; print(json.load(open('$OUT/summary.json'))['status'])")
MODE=$(python3 -c "import json; print(json.load(open('$OUT/summary.json'))['mode'])")
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
for i in 1 2 3; do
  if git push -q --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" HEAD:qa-results; then echo "Опубликовано в qa-results"; exit 0; fi
  sleep 5
done
echo "Не удалось опубликовать результаты"; exit 1
