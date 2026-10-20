// Подтверждение, что на GitHub Pages опубликован именно проверяемый коммит.
// 1) API GitHub Pages: последняя сборка относится к SITE_SHA и завершена (status = built).
// 2) HTML с сайта (запрос с уникальным параметром, без кэша) побайтно совпадает с index.html этого коммита.
//    Побайтовое сравнение допустимо: GitHub Pages с .nojekyll отдаёт файлы без изменений —
//    это подтверждено тестом доступа 20.10.2026 (совпадение для коммита 251992c).
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const { REPO, SITE_SHA, PAGE_URL, GITHUB_TOKEN } = process.env;
const expected = execSync(`git show ${SITE_SHA}:index.html`).toString();
const t0 = Date.now(), LIMIT = 10 * 60 * 1000;
const out = { ok: false, note: "", waited: 0, buildCommit: null, buildStatus: null, apiAvailable: true, byteMatch: false, superseded: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function latestBuild() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/pages/builds/latest`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } });
    if (!r.ok) { out.apiAvailable = false; return null; }
    const j = await r.json(); return { commit: j.commit, status: j.status };
  } catch { out.apiAvailable = false; return null; }
}
function remoteHead() {
  try { return execSync(`git ls-remote https://github.com/${REPO} refs/heads/gh-pages`).toString().split(/\s/)[0]; } catch { return null; }
}

while (Date.now() - t0 < LIMIT) {
  const head = remoteHead();
  if (head && head !== SITE_SHA) { out.superseded = true; out.note = `в gh-pages уже более новый коммит ${head.slice(0, 7)} — этот запуск не проверяет устаревшую версию`; break; }
  const b = await latestBuild();
  if (b) { out.buildCommit = b.commit; out.buildStatus = b.status; }
  const builtOk = b ? b.commit === SITE_SHA && b.status === "built" : true; // без API полагаемся на сравнение HTML
  if (builtOk) {
    try {
      const r = await fetch(`${PAGE_URL}?fresh=${Date.now()}`, { headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } });
      const live = await r.text();
      if (r.ok && live === expected) { out.byteMatch = true; out.ok = true; break; }
    } catch {}
  }
  await sleep(8000);
}
out.waited = Math.round((Date.now() - t0) / 1000);
if (out.ok) out.note = `сборка GitHub Pages ${out.apiAvailable ? `для ${SITE_SHA.slice(0, 7)} завершена` : "— API недоступен, подтверждено только по HTML"}; HTML на сайте побайтно совпадает с коммитом (ожидание ${out.waited} с)`;
else if (!out.superseded) out.note = `за ${out.waited} с опубликованная версия не совпала с коммитом (последняя сборка: ${out.buildCommit ? out.buildCommit.slice(0, 7) : "неизвестно"}, статус ${out.buildStatus ?? "неизвестен"})`;
writeFileSync("qa/freshness.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
