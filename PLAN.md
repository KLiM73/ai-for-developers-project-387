# PLAN — недочёты и направления развития

Две части: **баги** из code review (отсортированы по важности) и **фичи** развития проекта.
Чекбоксы — для отслеживания статуса.

---

## 🔴 Существенное

### 1. Гонка при создании брони (TOCTOU) — инвариант no-overlap не гарантирован БД
- [ ] **Файл:** `backend/app/controllers/bookings_controller.rb`
- **Проблема:** проверка `Booking.overlapping(...).exists?` и `booking.save` не атомарны. Два параллельных запроса на пересекающиеся слоты оба пройдут проверку и создадут двойную бронь. CLAUDE.md заявляет глобальный инвариант, но на уровне БД его нет — только проверка в приложении.
- **Риск:** двойное бронирование под нагрузкой.
- **Фикс:** обернуть проверку + сохранение в транзакцию с блокировкой; для SQLite (нет exclusion-constraint) — сериализовать запись (advisory lock / таблица-замок) либо явно задокументировать, что инвариант best-effort.

### 2. Docker: nginx проксирует admin-страницы SPA на Rails → при refresh отдаётся JSON
- [ ] **Файл:** `nginx.conf.template`
- **Проблема:** `location ~ ^/(event-types|bookings|admin|up)(/.*)?$` проксирует на Rails всё, что начинается с `/admin`. Но фронт-маршруты `/admin/event-types` и `/admin/bookings` совпадают с этим regex и одновременно являются API-эндпоинтами.
- **Следствие:** при прямой загрузке или F5 на `/admin/event-types` в Docker nginx отдаёт JSON от Rails вместо `index.html`. Админская часть SPA ломается при перезагрузке/прямой ссылке (клиентская навигация роутером работает).
- **Фикс:** развести API и SPA по непересекающимся префиксам (например, API под `/api/*`), либо матчить API в nginx точнее (по конкретным путям/методам).

### 3. `POST /bookings` не валидирует время слота
- [ ] **Файл:** `backend/app/controllers/bookings_controller.rb`
- **Проблема:** контроллер доверяет `startTime` от клиента — не проверяет, что время в будущем, попадает в 14-дневное окно и выровнено по сетке. `SlotGeneratorService` фильтрует `slot_start >= now`, а `create` — нет.
- **Следствие:** можно создать бронь в прошлом или вне окна прямым POST, минуя генерацию слотов.
- **Фикс:** добавить проверку `start_time >= Time.now.utc` (и при желании попадание в окно) в контроллере или модели.

---

## 🟡 Стоит учесть

### 4. CORS `origins "*"` + admin без аутентификации
- [ ] **Файл:** `backend/config/initializers/cors.rb`
- **Проблема:** открыт доступ для всех источников, а `/admin/*` не имеет auth (by design). CORS не защищает от прямых запросов — любой может дёргать `/admin/*`.
- **Фикс:** зафиксировать в README/CLAUDE «no auth — не для прода»; при необходимости сузить `origins`.

### 5. Дублирование slug: 409 vs 422
- [ ] **Файлы:** `backend/app/models/event_type.rb`, `backend/app/controllers/application_controller.rb`
- **Проблема:** при создании `EventType` с существующим `id` первой срабатывает модельная валидация `uniqueness: true` → `validation_error` (422). Документированный `RecordNotUnique` → 409 достижим только в гонке. Поведение двойственное.
- **Фикс:** осознать/выбрать один путь — либо убрать `uniqueness` и опираться на индекс + 409, либо привести документацию к 422.

### 6. Frontend: отображение времени в локальном TZ, генерация — в UTC
- [ ] **Файлы:** `backend/app/services/slot_generator_service.rb`, `frontend/src/components/guest/BookingForm.tsx`, `frontend/src/components/guest/SlotGrid.tsx`
- **Проблема:** сетка слотов строится от `now.beginning_of_day` в UTC (привязка к UTC-полуночи), а UI показывает `new Date(ts).toLocaleString()` в TZ браузера. Бронируется корректный UTC-момент, но набор/группировка слотов завязаны на UTC — может удивлять пользователей в других поясах. UX-замечание, не баг.
- **Фикс (опц.):** определиться с TZ-политикой и при необходимости генерировать сетку в нужном поясе.

### 7. `apiFetch` падает на не-JSON ответах
- [ ] **Файл:** `frontend/src/api/client.ts`
- **Проблема:** `await res.json()` бросит `SyntaxError` (не `ApiError`) на пустом/не-JSON теле (502 от nginx, 204). В местах, ждущих `isApiError()`, тип не нормализуется.
- **Фикс:** обернуть парсинг в try/catch и приводить к `ApiError` при сбое.

---

## 🟢 Мелочи / на будущее

- [ ] `entrypoint.sh` генерирует случайный `SECRET_KEY_BASE` при каждом старте без master key — для API-only без сессий ок, но значение меняется при рестарте. Отметить.
- [ ] `granularity` не имеет верхней границы (`backend/app/controllers/slots_controller.rb`). Не критично.
- [ ] Нет unit-тестов backend (по дизайну — только rubocop/brakeman/bundler-audit). Логика overlap/slot-generation — хорошие кандидаты на unit-тесты.
- [ ] Логика пересечения продублирована: `Booking.overlapping` (SQL) и `overlaps_any?` (in-memory в `SlotGeneratorService`). Легко рассинхронить — вынести в один источник правды.

---

## 🚀 Фичи / направления развития

### Фича 1 (главная) — Двухпанельный выбор времени (Calendly-style)
- [ ] **Файлы:** `frontend/src/components/guest/SlotGrid.tsx` (переработать или заменить на `SlotPicker.tsx`), `frontend/src/pages/guest/BookingPage.tsx` (минимальные правки, контракт `onSelect(slot)` сохранить).
- **Проблема сейчас:** `SlotGrid` рендерит **все** слоты на 14 дней сразу — дни вертикально, под каждым ряд кнопок-времён. При `granularity=30` это сотни кнопок одной простынёй: тяжело и неприятно.
- **Цель:** слева компактный календарь дат, справа слоты **только выбранного дня**.
- **Подход:**
  - Из `slots: TimeSlot[]` собрать `Map<dateKey, TimeSlot[]>` (ключ `YYYY-MM-DD` в выбранной TZ) — переиспользовать `reduce`-группировку и форматтеры `formatTime`/`formatDate` из текущего `SlotGrid`.
  - Состояние `selectedDate` (по умолчанию первый доступный день).
  - **Левая панель:** inline `DatePicker` из `@mantine/dates` (уже установлен — Mantine 9.2.2). Дни без слотов гасить через `getDayProps`/`excludeDate`; диапазон ограничить окном (`minDate=today`, `maxDate=today+14`); доступные дни подсветить.
  - **Правая панель:** кнопки-времена только для `grouped[selectedDate]` (текущий вид кнопок `outline/filled` + `onSelect`).
  - **Адаптив:** Mantine `SimpleGrid`/`Flex` — на узких экранах панели в столбик (календарь сверху, слоты под ним).
  - Пустое состояние «No availability» сохранить.
- **Переиспользовать:** `useSlots` (`frontend/src/hooks/useSlots.ts`), тип `TimeSlot` (`frontend/src/types/api.ts`), группировку и форматтеры из текущего `SlotGrid.tsx`.

### Фича 2 — Выбор таймзоны + индикатор
- [ ] **Файлы:** новый `frontend/src/lib/timezone.ts` (или `TimezoneContext`); `frontend/src/components/guest/SlotGrid.tsx`/`SlotPicker`, `frontend/src/components/guest/BookingForm.tsx`, `frontend/src/pages/guest/BookingSuccessPage.tsx`.
- **Цель:** явно показывать, в какой TZ отображается время, и дать переключатель. Закрывает замечание #6 (UTC-генерация vs локальный рендер).
- **Подход:**
  - По умолчанию `Intl.DateTimeFormat().resolvedOptions().timeZone`.
  - Переключатель — Mantine `Select` со списком `Intl.supportedValuesOf('timeZone')`.
  - Все форматтеры (`toLocaleString`/`toLocaleTimeString`) принимают `{ timeZone }`.
  - Подпись над слотами: «Times shown in <TZ>».
  - Бронируемый момент остаётся UTC (`selectedSlot.startTime` — UTC ISO), меняется только отображение.

### Фича 3 — Фильтр по дате в админ-бронированиях
- [ ] **Файлы:** `frontend/src/pages/admin/AdminBookingsPage.tsx`; `frontend/src/hooks/useAdminBookings.ts` (уже принимает `from?`). Backend готов: `GET /admin/bookings?from=<RFC3339>` парсится в `Admin::BookingsController`.
- **Цель:** дать админу выбрать дату «с какого момента показывать брони» (сейчас всегда `from = now`).
- **Подход:** `DateInput`/`DatePicker` из `@mantine/dates` → ISO-строка → проп в `useAdminBookings(from)`; кнопка «сбросить» (к now); опционально пресеты «сегодня / неделя / всё».

### Идеи на будущее (не выбраны)
- [ ] «Добавить в календарь» на success-странице — скачивание `.ics` + ссылка Google Calendar (чисто фронт).
- [ ] Скелетоны и аккуратные пустые состояния вместо одинокого `<Loader/>`.
- [ ] Поиск/фильтр типов событий на главной.
- [ ] Отмена брони по ссылке (требует backend `DELETE /bookings/:id`).

---

## Что хорошо (не трогать)

- Денормализация `event_type_name` на брони — переживает удаление/переименование типа.
- Единый конверт ошибок `{ code, message }` и аккуратная inline-сериализация в camelCase.
- Индексы на `event_type_id` и `start_time` — под overlap-запросы.
- Чистое разделение слоёв на фронте, query/mutation хуки, Page Object в e2e.
- Загрузка всех броней окна одним запросом в `SlotGeneratorService` — без N+1.
