# Lighthouse: ночная проверка и утренний разбор

Регулярный аудит фронтенда (performance, accessibility, best-practices, SEO) средствами
[Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci). Цель — каждое утро команда видит
свежий отчёт и решает, нужны ли правки.

## Как это работает

Workflow [`.github/workflows/lighthouse.yml`](../.github/workflows/lighthouse.yml):

1. **Ночью по расписанию** (`cron: '0 2 * * *'`, время в UTC ≈ 05:00 MSK) или **вручную**.
2. Собирает и поднимает приложение в Docker (`docker compose up --build`, как в проде: nginx + Rails
   на `http://localhost:3000`), ждёт health-эндпоинт `/up`.
3. Прогоняет `lhci autorun` — по 3 прогона на каждую страницу (берётся медиана) против `/` и
   `/admin/event-types`. Пороги и список URL — в [`lighthouserc.json`](../lighthouserc.json).
4. Сохраняет результат тремя способами (см. ниже).

## Где смотреть результат утром

1. **Job Summary** — самое быстрое. GitHub → вкладка **Actions** → workflow **Lighthouse** →
   последний запуск → внизу страницы таблица баллов по категориям (✅ / ⚠️ относительно порога).
2. **Детальный отчёт** — артефакт **`lighthouse-report`** на той же странице запуска (хранится 14 дней).
   Скачать, распаковать, открыть `*.report.html` — там разделы Opportunities / Diagnostics с
   конкретными рекомендациями.
3. **Авто-issue** — если performance или accessibility опустились ниже порога, workflow создаёт (или
   дополняет комментарием) issue с меткой **`lighthouse`**. Это и есть фиксация «какие правки нужны».

## Как фиксировать правки

- Открыть авто-issue с меткой `lighthouse` (или Job Summary, если просадки нет, но хочется улучшить).
- По `*.report.html` из артефакта определить конкретные узкие места.
- Завести задачи на исправление, по мере устранения закрыть issue.

## Запуск вручную

GitHub → **Actions** → **Lighthouse** → **Run workflow**. Можно задать `perf_threshold` (по умолчанию
`0.9`) — порог, ниже которого создаётся issue.

> Кнопка Run workflow и ночное расписание появляются только после попадания файла workflow в ветку по
> умолчанию (`main`) — таково ограничение GitHub Actions для `schedule` и `workflow_dispatch`.

## Настройка

- **Расписание** — поле `cron` в `lighthouse.yml` (UTC). Например, `'0 23 * * *'` ≈ 02:00 MSK.
- **Страницы и пороги** — `lighthouserc.json` (`collect.url`, `assert.assertions`). Пороги стоят на
  уровне `warn`, поэтому прогон не «краснеет» — решение принимает команда.
- **Запуск локально** (как в CI):
  ```bash
  docker compose up --build -d
  npm install -g @lhci/cli
  lhci autorun --config=lighthouserc.json
  node .github/scripts/lighthouse-report.mjs   # печать сводки (без GH_TOKEN issue не создаётся)
  docker compose down
  ```
