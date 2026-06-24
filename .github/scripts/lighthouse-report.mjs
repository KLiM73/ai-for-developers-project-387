#!/usr/bin/env node
// Разбирает отчёты Lighthouse CI (.lighthouseci/manifest.json):
//   1. печатает таблицу баллов в Job Summary запуска (GITHUB_STEP_SUMMARY);
//   2. при просадке performance/accessibility ниже порога заводит/обновляет
//      GitHub Issue с меткой "lighthouse" — фиксирует, какие правки нужны.
//
// Зависимостей нет. Запускается шагом workflow после `lhci autorun`.
// Без GH_TOKEN (например, локально) issue не создаётся — только печатается сводка.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MANIFEST = '.lighthouseci/manifest.json';
const LABEL = 'lighthouse';
const THRESHOLD = Number(process.env.PERF_THRESHOLD ?? '0.9');
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

if (!existsSync(MANIFEST)) {
  console.error(`Не найден ${MANIFEST} — Lighthouse CI не собрал отчёт. Пропускаю.`);
  process.exit(0);
}

/** @type {Array<{url: string, isRepresentativeRun: boolean, summary: Record<string, number>}>} */
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
// Берём по одному (репрезентативному = медианному) прогону на каждый URL.
const runs = manifest.filter((r) => r.isRepresentativeRun);

const pct = (score) => (score == null ? '—' : `${Math.round(score * 100)}`);
const emoji = (score) => (score == null ? '' : score >= THRESHOLD ? '✅' : '⚠️');

const header = `| URL | ${CATEGORIES.map((c) => c[0].toUpperCase() + c.slice(1)).join(' | ')} |`;
const divider = `| --- | ${CATEGORIES.map(() => '---').join(' | ')} |`;
const rows = runs.map((r) => {
  const path = new URL(r.url).pathname;
  const cells = CATEGORIES.map((c) => `${pct(r.summary[c])} ${emoji(r.summary[c])}`);
  return `| \`${path}\` | ${cells.join(' | ')} |`;
});

const table = [header, divider, ...rows].join('\n');

// Минимальные баллы по ключевым категориям среди всех страниц.
const lowestPerf = Math.min(...runs.map((r) => r.summary.performance ?? 1));
const lowestA11y = Math.min(...runs.map((r) => r.summary.accessibility ?? 1));
const regressed = lowestPerf < THRESHOLD || lowestA11y < THRESHOLD;

const summaryMd = [
  '## 🔦 Lighthouse',
  '',
  `Порог: **${THRESHOLD}** (${Math.round(THRESHOLD * 100)}). Баллы — медиана из ${
    manifest.length / Math.max(runs.length, 1)
  } прогонов на страницу.`,
  '',
  table,
  '',
  regressed
    ? `⚠️ Есть просадка ниже порога (performance ${pct(lowestPerf)}, accessibility ${pct(
        lowestA11y,
      )}). Детальные аудиты — в артефакте \`lighthouse-report\`.`
    : '✅ Все ключевые категории не ниже порога.',
  '',
].join('\n');

// 1. Job Summary
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + '\n');
}
console.log(summaryMd);

// 2. Issue при просадке (нужен gh + GH_TOKEN)
if (!regressed) {
  console.log('Просадок нет — issue не создаётся.');
  process.exit(0);
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log('Нет GH_TOKEN — пропускаю создание issue (вероятно, локальный запуск).');
  process.exit(0);
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

const title = 'Lighthouse: показатели ниже порога — нужны правки';
const body = [
  `Ночная проверка Lighthouse выявила просадку ниже порога **${THRESHOLD}**.`,
  '',
  table,
  '',
  '**Что делать:**',
  '- Открыть артефакт `lighthouse-report` последнего запуска workflow **Lighthouse** и посмотреть `*.report.html`.',
  '- По разделам Opportunities / Diagnostics определить конкретные правки.',
  '- Зафиксировать задачи на исправление и закрыть этот issue после устранения.',
  '',
  `_Создано автоматически из CI (run ${process.env.GITHUB_RUN_ID ?? 'local'})._`,
].join('\n');

try {
  // Гарантируем наличие метки (без падения, если уже есть).
  try {
    gh(['label', 'create', LABEL, '--color', 'D93F0B', '--description', 'Lighthouse regressions']);
  } catch {
    /* метка уже существует — ок */
  }

  const open = gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--jq', '.[0].number']).trim();

  if (open) {
    gh(['issue', 'comment', open, '--body', body]);
    console.log(`Обновлён существующий issue #${open}.`);
  } else {
    gh(['issue', 'create', '--title', title, '--label', LABEL, '--body', body]);
    console.log('Создан новый issue.');
  }
} catch (err) {
  console.error('Не удалось создать/обновить issue:', err.message);
  // Не валим job — отчёт уже собран и загружен.
}
