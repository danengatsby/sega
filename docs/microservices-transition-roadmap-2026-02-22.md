# Roadmap Tranziție Microservicii (3 sprinturi)

Data: 2026-02-22  
Scop: separare progresivă monolit -> servicii pe domenii, cu contracte API clare.

## Sprint 1 (livrat)

- Extracție `auth-service`:
  - runtime separat (`apps/backend/src/microservices/auth-service-app.ts`)
  - endpoint-uri `/api/auth/*`
  - healthcheck, metrics și docs OpenAPI dedicate
- Contract API:
  - `apps/backend/openapi/auth-service.openapi.json`

## Sprint 2 (livrat)

- Extracție `invoice-service`:
  - runtime separat (`apps/backend/src/microservices/invoice-service-app.ts`)
  - endpoint-uri `/api/invoices/*`
  - middleware complet auth + company context + DB request context
- Contract API:
  - `apps/backend/openapi/invoice-service.openapi.json`

## Sprint 3 (următor)

- `accounting-service` (plan conturi + jurnal + perioade)
- `reporting-service` (read-only rapoarte + exporturi)
- gateway/API composition peste cele 4 servicii (auth, invoice, accounting, reporting)

## Criteriu de acceptare curent

- Minim 2 servicii extrase: `auth-service` + `invoice-service` (îndeplinit)
- Fără regresii pe suita automată backend (îndeplinit)
