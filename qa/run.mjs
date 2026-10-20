// Запуск проверки. Переменные окружения:
//   BASE_URL   — адрес страницы (опубликованной или локальной), без параметров
//   SITE_SHA   — проверяемый коммит gh-pages (для отчёта и сброса кэша)
//   OUT_DIR    — куда писать результаты (по умолчанию qa/out)
//   PREV_DIR   — снимки предыдущей проверки; BASELINE_DIR — снимки эталона
//   QA_MODE    — fast | full (если не задан, выбирается автоматически)
//   BEFORE_SHA, COMMIT_MSG — для автоматического выбора режима
//   CHROMIUM_PATH — свой браузер (для локального запуска)
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logicSuite, transitionSuite, uiSuite, layoutSuite, WIDTHS } from "./checks.mjs";
import { shotPlan, takeShots, compare, contactSheets, failureShots } from "./visual.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = process.env.OUT_DIR || join(HERE, "out");
const SHA = process.env.SITE_SHA || "local";
const RAW = "https://raw.githubusercontent.com/jonysilvervi/digital-store-docs/qa-results/latest/";
const BLOB = "https://github.com/jonysilvervi/digital-store-docs/blob/qa-results/latest/";
const BASE = process.env.BASE_URL;
const t0 = Date.now(), T = {};
const lap = (k, s) => (T[k] = ((Date.now() - s) / 1000).toFixed(1));

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });

function decideMode() {
  if (process.env.QA_MODE) return [process.env.QA_MODE, "задан вручную"];
  const msg = process.env.COMMIT_MSG || "";
  if (/\[qa:(full|baseline)\]/.test(msg)) return ["full", "пометка в описании коммита"];
  if (/\[qa:fast\]/.test(msg)) return ["fast", "пометка [qa:fast] в описании коммита"];
  const before = process.env.BEFORE_SHA || "";
  if (!before || /^0+$/.test(before)) return ["full", "нет предыдущего коммита для сравнения"];
  if (!existsSync(process.env.PREV_DIR || "/nonexistent")) return ["full", "нет снимков предыдущей проверки"];
  try {
    const files = execSync(`git -C "${ROOT}" diff --name-only ${before} ${SHA}`).toString().trim().split("\n").filter(Boolean);
    if (files.some((f) => f.startsWith("qa/") || f.startsWith(".github/"))) return ["full", "изменена сама система проверки"];
    const style = (rev) => { const s = execSync(`git -C "${ROOT}" show ${rev}:index.html`).toString(); const m = s.match(/<style>[\s\S]*?<\/style>/); return m ? m[0] : ""; };
    if (files.includes("index.html") && style(before) !== style(SHA)) return ["full", "изменены стили страницы"];
    return ["fast", files.length ? `изменено: ${files.join(", ")}; стили не менялись` : "изменений файлов нет"];
  } catch (e) { return ["full", "не удалось сравнить с предыдущим коммитом"]; }
}

const freshness = existsSync(join(OUT, "..", "freshness.json")) ? JSON.parse(readFileSync(join(OUT, "..", "freshness.json"), "utf8")) : { ok: !!process.env.LOCAL_RUN, note: process.env.LOCAL_RUN ? "локальный запуск, сайт не публиковался" : "проверка версии не выполнялась" };
const [mode, modeReason] = decideMode();
const results = []; let status = "NOT_RUN", fatal = null, plan = [], sheets = [], vPrev = { available: false, items: [] }, vBase = { available: false, items: [] }, counts = {};

async function main() {
  if (!BASE) throw new Error("не задан BASE_URL");
  if (!freshness.ok) throw new Error(`опубликованная версия не подтверждена: ${freshness.note}`);
  const html = process.env.LOCAL_RUN ? readFileSync(join(ROOT, "index.html"), "utf8") : execSync(`git -C "${ROOT}" show ${SHA}:index.html`).toString();
  const m = html.match(/<script type="application\/json" id="catalog">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("в index.html нет блока данных каталога");
  const cat = JSON.parse(m[1]); // данные читаются из файла коммита, а не из логики страницы

  const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  if (process.env.CHROMIUM_ARGS) launch.args = process.env.CHROMIUM_ARGS.split("|");
  const browser = await chromium.launch(launch);
  const base = BASE + `?v=${SHA}`; // свой адрес для каждой версии — кэш не подменит страницу
  // Наборы изолированы: сбой или зависание одного не отменяет остальные и записывается как ошибка.
  const guard = async (key, title, fn, limitSec = 180) => {
    const s = Date.now(); console.log(`▶ ${title}`);
    let timer;
    try {
      return await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`превышено время ${limitSec} с`)), limitSec * 1000); })]);
    } catch (e) {
      results.push({ group: title, name: "Сбой выполнения набора проверок", ok: false, detail: String(e && e.message || e).split("\n")[0].slice(0, 300), url: null, path: null, width: 390, sel: null });
    } finally { clearTimeout(timer); lap(key, s); }
  };
  counts.offerTerm = await guard("logic", "Логика выбора и цены", () => logicSuite(browser, cat, base, results));
  await guard("transitions", "Автоматические изменения выбора", () => transitionSuite(browser, cat, base, results));
  await guard("ui", "Листы, вопросы и служебный режим", () => uiSuite(browser, cat, base, results));
  counts.layoutStates = await guard("layout", "Отображение", () => layoutSuite(browser, cat, base, results));
  plan = shotPlan(cat, mode);
  await guard("shots", "Снимки", () => takeShots(browser, base, plan, OUT));
  await guard("visual", "Сравнение и сводные листы", async () => {
    vPrev = compare(plan, OUT, process.env.PREV_DIR, "prev");
    vBase = compare(plan, OUT, process.env.BASELINE_DIR, "baseline");
    sheets = await contactSheets(browser, plan, OUT);
  });
  const fails = results.filter((r) => !r.ok);
  await guard("failshots", "Снимки ошибок", async () => { counts.failShots = await failureShots(browser, fails, OUT); }, 120);
  await browser.close();
  counts.offers = cat.offers.length; counts.tariffs = cat.tariffs.length;
  // повторная проверка: версия сайта не сменилась во время теста
  if (!process.env.LOCAL_RUN) {
    const live = await (await fetch(`${BASE}?recheck=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } })).text();
    if (live !== html) throw new Error("во время проверки на сайте появилась другая версия — результат недействителен");
  }
  status = fails.length ? "FAILED" : "PASSED";
}

try { await main(); } catch (e) { fatal = String(e && e.message || e).split("\n")[0]; status = "NOT_RUN"; }
T.total = ((Date.now() - t0) / 1000).toFixed(1);
writeReport();
process.exitCode = status === "PASSED" ? 0 : status === "FAILED" ? 1 : 2;

function writeReport() {
  const fails = results.filter((r) => !r.ok), passed = results.length - fails.length;
  const icon = { PASSED: "✅ ПРОЙДЕНО", FAILED: `❌ ЕСТЬ ОШИБКИ (${fails.length})`, NOT_RUN: "⚠️ ПРОВЕРКА НЕ ВЫПОЛНЕНА" }[status];
  const groups = {}; for (const r of results) { groups[r.group] ||= { ok: 0, fail: 0 }; groups[r.group][r.ok ? "ok" : "fail"]++; }
  const shortSha = SHA.slice(0, 7);
  const L = [];
  L.push(`# Отчёт проверки Digital Store`, ``, `## Итог: ${icon}`, ``);
  if (fatal) L.push(`**Причина:** ${fatal}`, ``, `Результаты ниже неполные. Непроведённая проверка не считается успешной.`, ``);
  L.push(`- Проверенная версия сайта: \`gh-pages\` [${shortSha}](https://github.com/jonysilvervi/digital-store-docs/commit/${SHA})`);
  L.push(`- Подтверждение версии: ${freshness.ok ? "да" : "нет"} — ${freshness.note || ""}`);
  L.push(`- Страница: ${BASE || "—"}`);
  L.push(`- Режим: **${mode === "full" ? "полный" : "быстрый"}** (${modeReason})`);
  if (process.env.RUN_URL) L.push(`- Журнал запуска на GitHub: ${process.env.RUN_URL}`);
  L.push(`- Время проверки (UTC): ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
  L.push(`- Длительность этапов, с: ожидание публикации ${freshness.waited ?? "—"} · логика ${T.logic ?? "—"} · переходы ${T.transitions ?? "—"} · листы ${T.ui ?? "—"} · отображение ${T.layout ?? "—"} · снимки ${T.shots ?? "—"} · сравнение и листы ${T.visual ?? "—"} · снимки ошибок ${T.failshots ?? "—"} · всего тестов ${T.total}`);
  L.push(``, `> Цены, остатки, прогнозы и условия на странице — **демонстрационные данные**. Проверка подтверждает только правильность отображения и расчётов по этим данным, а не их коммерческую достоверность.`, ``);

  L.push(`## Ошибки`, ``);
  if (!fails.length) L.push(fatal ? `Проверки не завершены.` : `Не найдено.`, ``);
  else fails.slice(0, 60).forEach((f, i) => {
    L.push(`${i + 1}. **${f.group}: ${f.name}**${f.detail ? ` — ${f.detail}` : ""}`);
    const bits = [];
    if (f.shot) bits.push(`[снимок](${RAW}${f.shot})`);
    if (f.path != null) bits.push(`ширина ${f.width} px · состояние \`${f.path || "(обычный адрес)"}\``);
    if (bits.length) L.push(`   ${bits.join(" · ")}`);
  });
  if (fails.length > 60) L.push(``, `…и ещё ${fails.length - 60} — полный список в summary.json.`);

  const vis = (v, title) => {
    L.push(``, `## ${title}`, ``);
    if (!v.available) { L.push(`Нет снимков для сравнения.`); return; }
    const ch = v.items.filter((x) => x.status !== "same");
    if (!ch.length) { L.push(`Отличий нет (порог 0,1% пикселей).`); return; }
    for (const x of ch) L.push(`- ${x.title} \`${x.file}\`: ${x.status === "changed" ? `изменилось ${(x.ratio * 100).toFixed(2)}% — [отличия](${RAW}${x.diff}) · [новый снимок](${RAW}shots/${x.file})` : x.status === "size" ? `изменился размер ${x.detail} — [новый снимок](${RAW}shots/${x.file})` : `новый снимок — [открыть](${RAW}shots/${x.file})`}`);
    L.push(``, `Отличия — информация, а не ошибка. Ошибки находят правила отображения выше.`);
  };
  const lastSha = (() => { try { return readFileSync(join(process.env.PREV_DIR || "", "LAST_SHA"), "utf8").trim().slice(0, 7); } catch { return null; } })();
  vis(vPrev, `Изменения по сравнению с предыдущими снимками${lastSha ? ` (последняя проверка — коммит ${lastSha})` : ""}`);
  vis(vBase, "Отличия от эталона");

  L.push(``, `## Сводные листы`, ``);
  if (!sheets.length) L.push(`Нет.`);
  for (const s of sheets) L.push(`- [${s.title}](${RAW}${s.file}) — ${s.count} экр.`);
  L.push(``, `Все снимки: ${BLOB}shots`);

  L.push(``, `## Что проверено`, ``);
  L.push(`- Всего проверок: ${results.length}, пройдено ${passed}, не пройдено ${fails.length}.`);
  if (counts.offers) L.push(`- Данные: ${counts.tariffs} тарифа, ${counts.offers} предложений; сочетаний «предложение × срок тарифа»: ${counts.offerTerm}.`);
  for (const [g, v] of Object.entries(groups)) L.push(`- ${g}: ${v.ok + v.fail} (ошибок ${v.fail})`);
  L.push(`- Ширина экрана в правилах отображения: ${WIDTHS.join(", ")} px; снимков в этом режиме: ${plan.length}.`);

  L.push(``, `## Что не проверялось`, ``);
  L.push(`- Настоящие телефоны, Safari и Firefox — снимает только Chromium.`);
  L.push(`- Экранные читалки и полный аудит доступности.`);
  L.push(`- Коммерческая достоверность цен, остатков и условий: это демо-данные.`);
  L.push(`- Смысл и стиль текстов, цвета и контраст — визуальный стиль ещё не утверждён.`);
  L.push(`- Наведение мышью, медленная сеть, другие страницы магазина (их пока нет).`);
  if (mode === "fast") L.push(`- Быстрый режим: снят сокращённый набор экранов; вся логика и правила отображения проверены полностью.`);
  writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ run_at: new Date().toISOString(), runUrl: process.env.RUN_URL || null, status, mode, modeReason, site: { sha: SHA, freshness }, timings: T, counts, fatal, results, visual: { prev: vPrev, baseline: vBase }, sheets, shots: plan.map((p) => p.file) }, null, 1));
  console.log(L.slice(0, 12).join("\n"));
  console.log(`checks: ${results.length}, failed: ${fails.length}, status: ${status}`);
}
