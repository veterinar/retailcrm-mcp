---
sdd:
  version: 1
  class: privileged
  mode: bugfix
  reasons: [nontrivial_bugfix, public_api_schema, runtime_mutation, deploy]
  base: e558e305bdd8d1d4c349fb491224bae1c5b0a2c9
  authority: {implementation: granted, publication: granted, runtime: granted}
---

# RetailCRM: чтение и связь повторных заказов

Основание: владелец 28.10.2026 поручил «исправь доработав mcp» после воспроизведения HTTP 0 bridge fatal при list/get и отсутствия клиентского ключа в analytics. Это разрешение на ограниченную доработку локального MCP; не на запись в CRM, рассылку, изменение ключей/разрешений или почтового транспорта.

Стратегия: flow-forward от указанного base. Источник actual behavior — код и live native tool readback; критерии задают required behavior, квитанция фиксирует наблюдённое.

## Delta

- ADDED: `customer_join_key` и `customer_join_key_reason` в общей безопасной order projection. Источник только `order.customer.id`; домен HMAC отличается от order key; одинаковый внутренний customer ID одной CRM связывает заказы разных сайтов. Область стабильности — одна CRM и неизменный HMAC secret.
- MODIFIED: ошибочные параметры read handlers после сверки с API v5; обработка ошибок PHP bridge сохраняет настоящий HTTP status для API-ошибок, внутренние ошибки выдаёт безопасно и без тела ответа/контактов/секретов.
- UNCHANGED: прежний order `join_key`, платежный/lifecycle/item/attribution контракт, привязанные credentials и права, реальные CRM-данные, почтовый транспорт.
- REMOVED: ничего. Диагноз не выводится из покупок.

## Acceptance

- AC-1: два разных заказа одного явного валидного customer.id дают один клиентский ключ; разные клиенты — разные ключи, site не дробит клиента внутри CRM.
- AC-2: отсутствующий/невалидный customer.id даёт null и причину; email/телефон/order ID/clientId не используются как замена. Нет сырого customer ID или contact fields в analytics.
- AC-3: существующий order join_key остаётся побайтно прежним; платежи, lifecycle, пагинация и отказ при невалидном HMAC secret сохраняются.
- AC-4: корректные list/get запросы читают заказы/клиентов; `by=id` передаётся явно. Параметры, не поддерживаемые API, не уходят как заведомо некорректный запрос. Аналогичный read-механизм проверен у существующих callers.
- AC-5: API 400/404 сохраняют статус; неожиданный Throwable/fatal не превращается в успех. Диагностика не раскрывает request/response body, credentials или контакты.
- AC-6: кандидат проходит целевые регрессии/сборку, устанавливается только в локальный RetailCRM MCP с резервом и точной identity/readback; ноль CRM writes. Если test runner не допускает дочерний процесс, тест не считается запущенным.

## Проверка и откат

Unit: customer namespace/invalid IDs/legacy golden key; API params и безопасные ошибки. Независимый live read: известные реальные повторные заказы с одним customer key; только обезличенная проекция в квитанции. Сохранять точную pre-update конфигурацию записи retailcrm и image digest. Откат — прежний image/config, без мутации CRM или новых ключей.

Наблюдённый RED: native limit=1 и фильтр статуса дали HTTP0; by=id get не передаёт by=id; analytics не содержит customer key. Native list с limit=20 без status читает данные. Причина PHP fatal уточняется безопасной диагностикой; не объявлять её установленной по одному generic сообщению.
