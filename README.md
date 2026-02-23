# SEGA Accounting MVP (Vite + Node + TypeScript + PostgreSQL)

[![ANAF Smoke](https://github.com/danengatsby/sega/actions/workflows/anaf-smoke.yml/badge.svg)](https://github.com/danengatsby/sega/actions/workflows/anaf-smoke.yml)
[![OpenAPI Contract](https://github.com/danengatsby/sega/actions/workflows/openapi-contract.yml/badge.svg)](https://github.com/danengatsby/sega/actions/workflows/openapi-contract.yml)
[![Performance KPI](https://github.com/danengatsby/sega/actions/workflows/performance-kpi.yml/badge.svg)](https://github.com/danengatsby/sega/actions/workflows/performance-kpi.yml)
[![DR Restore Drill](https://github.com/danengatsby/sega/actions/workflows/dr-restore-drill.yml/badge.svg)](https://github.com/danengatsby/sega/actions/workflows/dr-restore-drill.yml)
[![Observability Config](https://github.com/danengatsby/sega/actions/workflows/observability-config.yml/badge.svg)](https://github.com/danengatsby/sega/actions/workflows/observability-config.yml)


Implementare MVP pentru aplicația de contabilitate descrisă în document, cu arhitectură pe 3 niveluri:

- Frontend: React + Vite + TypeScript (`apps/frontend`)
- Backend API: Node.js + Express + TypeScript (`apps/backend`)
- Bază de date: PostgreSQL + Prisma ORM
- Infrastructură locală/extinsă: Redis, Bull queue, MinIO, Nginx, Prometheus, ELK, K8s manifests (`docker-compose.yml`, `infra/`)

## Ce este implementat

- Autentificare JWT și roluri (`ADMIN`, `CHIEF_ACCOUNTANT`, `ACCOUNTANT`, `CASHIER`, `MANAGER`, `AUDITOR`)
- Administrare multi-utilizator / multi-firmă:
  - conturi separate per contabil (nume, email, parolă)
  - firme multiple per contabil, cu rol distinct pe firmă
  - comutare firmă activă în UI + companie implicită per utilizator
  - date de identificare firmă extinse (CUI, reg. comerț, adresă, oraș, județ, țară, bancă, IBAN, contact)
- Plan de conturi (`accounts`) + operatii CRUD, cu seed OMFP extins (600+ conturi sintetice/analitice)
- Jurnal contabil cu înregistrare dublă (`journal_entries`, `journal_lines`), validare debit=credit
- Parteneri (`partners`) pentru clienți/furnizori
- Facturi clienți (`invoices`) + încasări (`payments`) cu postare contabilă automată
- Modul stocuri:
  - articole de stoc (`stock_items`)
  - NIR (intrări), bon consum (ieșiri), inventar (regularizări +/-)
  - metode evaluare FIFO/CMP
- Modul salarii:
  - angajați (`employees`)
  - generare stat salarii cu CAS/CASS/CAM/impozit/net
  - postare contabilă automată salarii
- Modul mijloace fixe:
  - registru active (`assets`)
  - rulare amortizare lunară (liniară/degresivă/accelerată)
  - postare contabilă automată amortizare
- Export declarații ANAF XML (MVP):
  - D300 (TVA)
    - calcul TVA colectata/deductibila din facturi emise/primite, cu reconciliere pe rulaje contabile 4427/4426 cand exista postari
  - D394 (operațiuni interne)
  - D112 (obligații salariale)
  - D101 (impozit pe profit), D100 (impozit micro), D205
  - D392, D393, D406 (SAF-T extins: MasterFiles + GeneralLedgerEntries + SourceDocuments)
    - mapări stricte coduri SAF-T (tip cont / tip document) + raport conformitate (`d406-conformity`)
  - validare profil declarație + validare XSD locală (opțională, cu `xmllint`)
- e-Factura end-to-end (RO e-Factura):
  - generare XML UBL/CIUS-RO pentru factură emisă
  - upload la ANAF (`/upload`), polling status (`/stareMesaj`)
  - download XML semnat (`/descarcare`) și arhivare în MinIO (S3-compatible)
  - moduri configurabile: `off`, `mock`, `live`
- Import extrase bancare multi-format:
  - endpoint upload fișier (`multipart/form-data`) pentru `MT940`, `CAMT.053 (XML)` și `CSV`
  - mapare validată pentru câmpuri cheie (`date`, `amount`, `IBAN`) și limită 5000 linii/import
  - endpoint JSON existent păstrat pentru import intern programatic
- Open Banking PSD2 (pilot):
  - conector pilot BCR (`OAuth2` token exchange + refresh)
  - sincronizare solduri și tranzacții în `bank_statements` / `bank_statement_lines`
  - sincronizare incrementală zilnică (scheduler UTC) + monitorizare erori per conexiune/run
- Tranziție progresivă spre microservicii (pilot P2-01):
  - `auth-service` extras (runtime separat) pentru domeniul autentificare/autorizare
  - `invoice-service` extras (runtime separat) pentru domeniul facturare/încasări clienți
  - contracte OpenAPI dedicate per serviciu (`openapi/auth-service.openapi.json`, `openapi/invoice-service.openapi.json`)
- Notificări sistematice (email/SMS/push):
  - worker dedicat notificări (`Bull + Redis`, fallback polling in-memory)
  - template-uri per eveniment și canal
  - event hooks pentru facturi emise/încasate, facturi furnizor create/plătite, payroll generat și Revisal livrat
- Revisal end-to-end:
  - export XML Revisal pentru perioada salarială
  - validare structurală XSD locală (cu `xmllint`, când este disponibil)
  - flux operațional de livrare (`GENERATED -> DELIVERED`) cu trasabilitate audit
- Procesare joburi export:
  - worker `Bull + Redis` pentru rulare asincronă
  - fallback automat pe polling DB dacă Redis este indisponibil
- Logging centralizat:
  - request/error logs în JSON
  - transport TCP către Logstash (`LOGSTASH_ENABLED=true`, host/port configurabile)
  - filtrare request logs configurabilă (`LOG_REQUEST_FILTER=auto|all|non-2xx|errors-only`)
- Hardening DB enterprise:
  - chei primare/fk UUID v4 (`@default(uuid())`, `@db.Uuid`)
  - politici Row-Level Security pe tabele multi-company
  - triggere DB pentru `updatedAt` și audit trail server-side
  - materialized views pentru balanță, P&L lunar, aging, cashflow și sinteză TVA
  - index tuning pentru rute KPI (trigram search + indexuri compuse pentru filtre/sortări pe invoices/accounts/dashboard)
- KPI performanță operaționalizați:
  - suită k6 cu praguri blocante `p95/p99` pe rute critice (`/api/invoices`, `/api/accounts`, `/api/reports/dashboard-bi`)
  - suită JMeter echivalentă + validare automată praguri din `.jtl`
  - fixture seed dedicat volumului de test (parteneri + facturi clienți/furnizori + user ACCOUNTANT fără MFA)
- DR (RTO/RPO) operaționalizat:
  - proceduri automate de backup PostgreSQL (`pg_dump`) și restore (`pg_restore`)
  - exercițiu automat de restore cu validare row-count pe tabele `public` și raport JSON
  - workflow lunar programat pentru restore drill (`.github/workflows/dr-restore-drill.yml`)
- Control conformitate avansată (GDPR retention + audit ops):
  - job retention audit log cu păstrare minimă 10 ani (3650 zile), rulare zilnică + trigger manual
  - politică explicită de acces audit pe roluri configurabile (`COMPLIANCE_AUDIT_ALLOWED_ROLES`)
  - raport conformitate verificabil (`/api/compliance/report`) cu evidențe runtime
- Observabilitate enterprise (SLO + on-call):
  - dashboard Grafana `SEGA SLO Overview` pentru uptime/latenta/error rate/throughput
  - reguli Prometheus pentru SLO availability/latency p95 si alertare continua
  - integrare Alertmanager catre receiver on-call + runbook incident response dedicat
- Rapoarte:
  - Balanță de verificare
  - P&L simplificat
  - Bilanț simplificat
  - Aging report creanțe
  - Export XBRL anual (`/api/reports/export/financial.xbrl?year=YYYY`) cu validare XSD locală
- Dashboard BI extins:
  - KPI financiari extinși (AR/AP, cash, net exposure, current ratio, marjă netă)
  - forecast cashflow 30/60/90 zile
  - analiză comparativă explicită: luna curentă vs luna anterioară vs aceeași lună din anul precedent
  - alerte configurabile pentru scadențe/restanțe (prag zile, grace, sumă minimă, max alerte)
- Audit trail (`audit_log`) extins: user_id/email/rol/sesiune, timestamp UTC, IP, user-agent, `old_values/new_values` (plus compat `beforeData/afterData`)
- Dashboard web pentru operare rapidă

## Structură

- `apps/backend/prisma/schema.prisma` - modelul bazei de date
- `apps/backend/prisma/sql/enterprise-hardening.sql` - RLS, triggere, materialized views (idempotent)
- `apps/backend/src/routes` - endpoint-uri API pe module
- `apps/backend/src/microservices` - entrypoint-uri pentru servicii extrase (`auth-service`, `invoice-service`)
- `apps/backend/src/seed.ts` - seed conturi standard + admin
- `apps/backend/openapi/auth-service.openapi.json` - contract OpenAPI serviciu auth
- `apps/backend/openapi/invoice-service.openapi.json` - contract OpenAPI serviciu invoice
- `apps/frontend/src/App.tsx` - interfață modulară
- `docker-compose.yml` - stack local (PostgreSQL + Redis + MinIO + profile Nginx/Prometheus/ELK)
- `infra/nginx`, `infra/prometheus`, `infra/grafana`, `infra/logstash` - configurații infrastructură
- `infra/k8s` - manifests Kubernetes (core/observability/logging)
- `infra/k8s/overlays/production-base` - bază producție (PVC, TLS ingress, patch-uri comune)
- `infra/k8s/overlays/production-vault` - producție + External Secrets (HashiCorp Vault)
- `infra/k8s/overlays/production-aws` - producție + External Secrets (AWS Secrets Manager)
- `infra/k8s/overlays/production-gcp` - producție + External Secrets (GCP Secret Manager)
- `infra/k8s/overlays/production-azure` - producție + External Secrets (Azure Key Vault)
- `infra/k8s/overlays/production` - alias compatibil pentru Vault

## Pornire rapidă

1. Copiere variabile mediu:

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env
```

2. Pornește infrastructura de bază (PostgreSQL + Redis + MinIO):

```bash
npm run db:up
```

3. Generează schema + obiectele SQL enterprise:

```bash
npm run db:bootstrap
npm run db:seed
```

Notă migrare: dacă ai o bază locală existentă cu ID-uri `cuid()`, conversia la UUID tip nativ necesită reset/migrare dedicată. Pentru mediu local de dezvoltare:

```bash
npm run db:bootstrap:reset
npm run db:seed
```

4. Rulează aplicația completă:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`
- API Docs (Swagger UI): `http://localhost:4000/api/docs`
- OpenAPI JSON: `http://localhost:4000/api/openapi.json`
- Metrics (Prometheus): `http://localhost:4000/metrics`
- PostgreSQL (Docker): `localhost:5434`
- Redis (Docker): `localhost:6379`
- MinIO API (Docker): `http://localhost:9000`
- MinIO Console (Docker): `http://localhost:9001`

Rulare servicii extrase (opțional, în paralel cu/sau în loc de monolit):

```bash
npm run auth-service:dev
npm run invoice-service:dev
```

- Auth service: `http://localhost:4101`
- Invoice service: `http://localhost:4102`

## Date login inițiale

- Email: `admin@sega.local`
- Parolă: valoarea din `ADMIN_PASSWORD` (`apps/backend/.env`)

(se configurează din `apps/backend/.env`)

## API principal

- `POST /api/auth/login`
- `POST /api/auth/switch-company`
- `GET /api/admin/companies`
- `POST /api/admin/companies`
- `PATCH /api/admin/companies/:id`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/reset-password`
- `POST /api/admin/memberships`
- `PATCH /api/admin/memberships/:id`
- `DELETE /api/admin/memberships/:id`
- `GET/POST/PATCH /api/accounts`
- `GET/POST /api/journal-entries`
- `GET/POST /api/partners`
- `GET/POST /api/invoices`
- `POST /api/invoices/:id/pay`
- `POST /api/invoices/:id/efactura/send`
- `POST /api/invoices/:id/efactura/poll`
- `GET /api/invoices/:id/efactura/signed-xml`
- `GET /api/stocks/items`
- `POST /api/stocks/items`
- `GET /api/stocks/movements`
- `POST /api/stocks/nir`
- `POST /api/stocks/consumptions`
- `POST /api/stocks/inventory`
- `GET/POST/PATCH /api/employees`
- `GET /api/payroll/runs`
- `POST /api/payroll/runs/generate`
- `GET /api/revisal/exports`
- `POST /api/revisal/exports`
- `GET /api/revisal/exports/:id`
- `GET /api/revisal/exports/:id/xml`
- `POST /api/revisal/exports/:id/deliver`
- `GET/POST /api/assets`
- `POST /api/assets/run-depreciation`
- `GET /api/reports/financial-statements`
- `GET /api/reports/dashboard-bi?asOf=YYYY-MM-DD&dueSoonDays=7&overdueGraceDays=0&minAmount=0&maxAlerts=20`
- `GET /api/reports/export/financial.pdf`
- `GET /api/reports/export/financial.excel`
- `GET /api/reports/export/financial.xml`
- `GET /api/reports/export/financial.xbrl?year=YYYY`
- `GET /api/reports/export/anaf/d300.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d394.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d112.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d101.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d100.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d205.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d392.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d393.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d406.xml?period=YYYY-MM`
- `GET /api/reports/export/anaf/d406-conformity?period=YYYY-MM`
- `GET /api/reports/export/anaf/validation?period=YYYY-MM`
- `GET /api/reports/trial-balance`
- `GET /api/reports/pnl`
- `GET /api/reports/balance-sheet`
- `GET /api/reports/aging-receivables`
- `GET /api/audit-log`
- `GET /api/compliance/report`
- `POST /api/compliance/retention/run`
- `POST /api/bank-reconciliation/statements/import` (JSON intern)
- `POST /api/bank-reconciliation/statements/import-file` (upload `file` + `accountCode`, format `AUTO|MT940|CAMT053|CSV`)
- `GET /api/open-banking/connections`
- `POST /api/open-banking/connections`
- `PATCH /api/open-banking/connections/:id/status`
- `POST /api/open-banking/connections/:id/oauth2/token`
- `POST /api/open-banking/connections/:id/sync`
- `GET /api/open-banking/connections/:id/sync-runs`
- `GET /metrics`

Exemplu upload extras (MT940/CAMT.053/CSV):

```bash
curl -X POST http://localhost:4000/api/bank-reconciliation/statements/import-file \
  -H "Authorization: Bearer <access-token>" \
  -F "accountCode=5121" \
  -F "format=AUTO" \
  -F "file=@/path/to/statement.mt940"
```

Config Open Banking (pilot BCR) în `apps/backend/.env`:

```dotenv
OPEN_BANKING_ENABLED=true
OPEN_BANKING_PILOT_BANK=bcr
OPEN_BANKING_DAILY_SYNC_HOUR_UTC=3
OPEN_BANKING_BCR_TOKEN_URL=https://<bank>/oauth2/token
OPEN_BANKING_BCR_ACCOUNTS_URL=https://<bank>/open-banking/accounts
OPEN_BANKING_BCR_TRANSACTIONS_URL=https://<bank>/open-banking/accounts/{accountId}/transactions
OPEN_BANKING_BCR_CLIENT_ID=<client-id>
OPEN_BANKING_BCR_CLIENT_SECRET=<client-secret>
```

Config Notificări (worker + canale) în `apps/backend/.env`:

```dotenv
NOTIFICATIONS_ENABLED=true
NOTIFICATION_QUEUE_MODE=auto
NOTIFICATION_CHANNELS=email,sms,push
NOTIFICATION_TARGET_ROLES=ADMIN,CHIEF_ACCOUNTANT,MANAGER
NOTIFICATION_INCLUDE_ACTOR=false
NOTIFICATION_EMAIL_RECIPIENTS=
NOTIFICATION_SMS_RECIPIENTS=
NOTIFICATION_PUSH_RECIPIENTS=
NOTIFICATION_EMAIL_WEBHOOK_URL=
NOTIFICATION_SMS_WEBHOOK_URL=
NOTIFICATION_PUSH_WEBHOOK_URL=
```

Config Conformitate (retention + audit policy) în `apps/backend/.env`:

```dotenv
COMPLIANCE_RETENTION_ENABLED=true
COMPLIANCE_RETENTION_DAYS=3650
COMPLIANCE_RETENTION_DAILY_HOUR_UTC=2
COMPLIANCE_AUDIT_ALLOWED_ROLES=ADMIN,CHIEF_ACCOUNTANT,MANAGER,AUDITOR
```

Config porturi servicii extrase în `apps/backend/.env`:

```dotenv
AUTH_SERVICE_PORT=4101
INVOICE_SERVICE_PORT=4102
```

## Stack infrastructură (opțional)

- Nginx reverse proxy (port `8088`):

```bash
npm run nginx:up
```

- Prometheus + Alertmanager + Grafana + Redis exporter + on-call webhook mock (porturi `9090`, `9093`, `3000`, `18080`):

```bash
npm run observability:up
```

UI observabilitate:
- Prometheus: `http://localhost:9090`
- Alertmanager: `http://localhost:9093`
- Grafana: `http://localhost:3000` (default `admin/admin`)
- On-call webhook mock: `http://localhost:18080`

Configurari cheie:
- reguli/alerte SLO: `infra/prometheus/slo-alerts.yml`
- receiver on-call: `infra/prometheus/alertmanager.yml`
- dashboard SLO: `infra/grafana/dashboards/sega-slo-overview.json`
- runbook incident response: `docs/incident-response-runbook.md`

Pentru integrare reala on-call (PagerDuty/Opsgenie/Slack webhook), inlocuieste URL-ul receiver-ului din `infra/prometheus/alertmanager.yml`.

- ELK (Elasticsearch `9200`, Logstash `5044/9600`, Kibana `5601`):

```bash
npm run elk:up
```

- Activare trimitere loguri backend către Logstash:

```bash
# apps/backend/.env
LOGSTASH_ENABLED=true
LOGSTASH_HOST=localhost
LOGSTASH_PORT=5044
LOG_REQUEST_FILTER=auto
LOG_REQUEST_EXCLUDE_PATHS=/metrics,/api/health
```

- Oprire infrastructură:

```bash
npm run infra:down
```

## Kubernetes producție (overlays providers)

`infra/k8s/overlays/production-base` adaugă peste baza existentă:
- PVC pentru MinIO și Prometheus
- TLS pe Ingress prin `cert-manager` (`ClusterIssuer` + secret TLS)
- patch-uri comune de hardening pentru deployment-urile existente

Provider overlays gata de aplicat:
- Vault: `infra/k8s/overlays/production-vault`
- AWS Secrets Manager: `infra/k8s/overlays/production-aws`
- GCP Secret Manager: `infra/k8s/overlays/production-gcp`
- Azure Key Vault: `infra/k8s/overlays/production-azure`

Prerechizite:
- NGINX Ingress Controller
- `cert-manager` instalat în cluster
- External Secrets Operator instalat în cluster
- backend de secrete configurat (în manifestul exemplu: Vault)

Aplicare (alege un singur provider):

```bash
kubectl apply -k infra/k8s/overlays/production-vault
# sau
kubectl apply -k infra/k8s/overlays/production-aws
# sau
kubectl apply -k infra/k8s/overlays/production-gcp
# sau
kubectl apply -k infra/k8s/overlays/production-azure
```

Ajustări obligatorii înainte de deploy:
- `infra/k8s/overlays/production-base/tls-issuer.yaml`: schimbă `email` și, dacă e nevoie, issuer-ul (staging/prod)
- `infra/k8s/overlays/production-base/patch-ingress-tls.yaml`: schimbă domeniul (`app.sega.local`)
- `infra/k8s/overlays/production-vault/external-secrets-vault.yaml`: schimbă `vault.server`, `role`, `remoteRef`
- `infra/k8s/overlays/production-aws/external-secrets-aws.yaml`: schimbă `role-arn`, `region`, `remoteRef`
- `infra/k8s/overlays/production-gcp/external-secrets-gcp.yaml`: schimbă `PROJECT_ID`, `clusterName/location`, naming secret keys
- `infra/k8s/overlays/production-azure/external-secrets-azure.yaml`: schimbă `client-id`, `vaultUrl`, naming secret keys

## Acoperire față de document

MVP-ul acoperă Faza 1-4 la nivel operațional (fundament, documente comerciale, stocuri, salarii, mijloace fixe și raportare/export financiar), inclusiv exporturi ANAF, validare locală de profil/XSD, flux e-Factura (upload/poll/download XML semnat), export Revisal cu flux de livrare operațional și export XBRL anual. Modulele avansate rămase pentru etapele următoare: semnare digitală calificată pentru fluxuri fiscale, workflow-uri avansate de aprobare și extindere BI.

## Backlog de aliniere (Gap Closure)

Backlog-ul executabil P0/P1/P2, mapat pe capitolele planului v3.0, este disponibil aici:

- `docs/gap-backlog-2026-02-22.md`
- `docs/microservices-transition-roadmap-2026-02-22.md`
- `docs/raport-final-conformitate-2026-02-23.md`
- `docs/plan-inchidere-conformitate-partiala-2026-02-23.md`
- `docs/kpi-business-dictionary-2026-02-23.md`
- `docs/traceability-matrix-2026-02-23.md`

## Contracte microservicii extrase

Generare contracte OpenAPI dedicate serviciilor extrase:

```bash
npm run openapi:service-contracts -w backend
```

Fișiere rezultate:
- `apps/backend/openapi/auth-service.openapi.json`
- `apps/backend/openapi/invoice-service.openapi.json`

## Validare XSD ANAF (SPV-ready local)

1. Configurează în `apps/backend/.env`:
  - `ANAF_VALIDATE_XSD=true`
  - `ANAF_XSD_DIR=./anaf/xsd`
  - date contribuabil (`ANAF_COMPANY_*`, `ANAF_DECLARANT_*`)
2. Pune schemele oficiale în `apps/backend/anaf/xsd`:
  - `d300.xsd`, `d394.xsd`, `d112.xsd`, `d406.xsd`
3. Instalează `xmllint` (libxml2) pe server.
4. Rulează export cu validare:
  - `.../api/reports/export/anaf/d300.xml?period=2026-02&validate=true`
  - `.../api/reports/export/anaf/d300.xml?period=2026-02&validate=true&strict=true`

Validare Revisal (opțional):
- schema locală: `apps/backend/revisal/xsd/revisal-export.xsd`
- generare export: `POST /api/revisal/exports`
- dacă `xmllint` este disponibil, rezultatul validării se persistă în câmpurile `validation*` ale exportului Revisal

Validare XBRL (anual):
- schema locală: `apps/backend/xbrl/xsd/sega-xbrl-instance.xsd`
- export: `GET /api/reports/export/financial.xbrl?year=2025&validate=true`
- strict mode: `GET /api/reports/export/financial.xbrl?year=2025&validate=true&strict=true`

## Smoke Test ANAF (automat)

Rulare rapidă pentru verificarea exporturilor ANAF + headere XSD (`performed=true`, `valid=true`) pe D300, D394, D112, D406.

1. Pornește backend-ul (`npm run backend:dev` sau `npm run dev`).
2. Rulează smoke test-ul:

```bash
npm run anaf:smoke
```

Open Banking PSD2 smoke (OAuth2 + sync manual + sync scheduler zilnic, cu bancă mock locală):

```bash
npm run open-banking:smoke
```

Notă: scriptul pornește intern un mock bank server + o instanță backend temporară; nu necesită backend deja pornit.

Alternativ, one-shot (build + start backend + smoke + stop backend):

```bash
npm run anaf:smoke:up
```

Prin `Makefile` (shortcut):

```bash
make smoke
make ci-smoke
make ci-smoke-down
```

Variabile opționale:

- `ANAF_SMOKE_BASE_URL` (default: `http://localhost:4000`)
- `ANAF_SMOKE_EMAIL` (default: `admin@sega.local`)
- `ANAF_SMOKE_PASSWORD` (default: valoarea din `ADMIN_PASSWORD`)
- `ANAF_SMOKE_PERIOD` (default: luna UTC curentă, format `YYYY-MM`)

Exemplu:

```bash
ANAF_SMOKE_PERIOD=2026-02 npm run anaf:smoke
```

## Performance KPI (k6 + JMeter)

Acoperire operațională pentru KPI tehnici (`p95/p99`) pe rutele țintă:
- `GET /api/invoices` (listare paginată + search)
- `GET /api/accounts` (listare paginată + search)
- `GET /api/reports/dashboard-bi` (buget separat, conform SLA de raportare)

1. Seed fixture-uri de performanță (idempotent):

```bash
npm run perf:seed
```

Prerechizite locale:
- `k6` instalat în PATH pentru `npm run perf:k6`
- `jmeter` instalat în PATH pentru `npm run perf:jmeter`
- fallback suportat: `~/.local/bin/k6` și `~/.local/bin/jmeter` (detectate automat de scripturile de perf)

2. Rulează suita k6 cu praguri blocante:

```bash
npm run perf:k6
```

3. Rulează suita JMeter + validare bugete din JTL:

```bash
npm run perf:jmeter
```

Variabile utile:
- `PERF_BASE_URL` (default `http://127.0.0.1:4000`)
- `PERF_USER_EMAIL` (default `perf.accountant@sega.local`)
- `PERF_USER_PASSWORD` (obligatoriu)
- `PERF_TARGET_P95_MS` (default `300`)
- `PERF_TARGET_P99_MS` (default `700`)
- `PERF_DASHBOARD_P95_MS` (default `1000`)
- `PERF_DASHBOARD_P99_MS` (default `2000`)

## DR Backup/Restore (RTO/RPO)

Prerechizite locale:
- `pg_dump`, `pg_restore`, `psql` instalate (PostgreSQL client tools)
- `DATABASE_URL` setat spre baza sursă

Comenzi:

```bash
npm run dr:backup
npm run dr:restore -- --backup-file apps/backend/dr/backups/<fisier>.dump --target-db sega_restore_test
npm run dr:drill
```

Prin `Makefile`:

```bash
make dr-backup
make dr-restore-drill
```

Ce verifică `dr:drill`:
- backup complet + checksum SHA256
- restore într-o bază izolată
- compară `count(*)` pentru toate tabelele din schema `public` (sursă vs restore)
- validează țintele:
  - `DR_RTO_TARGET_SECONDS` (default `3600`)
  - `DR_RPO_TARGET_SECONDS` (default `900`)

Artefacte locale:
- backup: `apps/backend/dr/backups/*.dump`
- metadata backup: `apps/backend/dr/backups/*.metadata.json`
- raport drill: `apps/backend/dr/reports/restore-drill-*.json`

## CI (GitHub Actions)

Validările automate rulează prin workflow-urile:

- `.github/workflows/anaf-smoke.yml`
- `.github/workflows/security-gates.yml` (dependency scan + secret scan, gate blocant la severitate HIGH/CRITICAL)
- `.github/workflows/openapi-contract.yml` (generare + validare OpenAPI 3.0, inclusiv acoperire 100% endpoint-uri critice)
- `.github/workflows/performance-kpi.yml` (seed KPI + k6 + JMeter cu bugete p95/p99 blocante)
- `.github/workflows/dr-restore-drill.yml` (backup + restore + validare DR, programat lunar + manual)
- `.github/workflows/observability-config.yml` (validare config Prometheus/Alertmanager/Grafana + docker-compose observability)

Aplicare branch protection (required checks) pentru enforcement complet:

```bash
GITHUB_TOKEN=<token-cu-admin-repo> ./scripts/github-enforce-security-gates.sh owner/repo
```

Scriptul aplică branch protection pe `main`/`master` (dacă există) și setează check-urile obligatorii:
`ANAF Smoke`, `Security Gates`, `OpenAPI Contract`, `Performance KPI`.

Workflow-urile de gate (`ANAF Smoke`, `Security Gates`, `OpenAPI Contract`, `Performance KPI`) se execută la:

- `push` pe `main`/`master`
- `pull_request`
- rulare manuală (`workflow_dispatch`)

Workflow-ul `DR Restore Drill` se execută:

- lunar (cron: `0 3 1 * *`)
- manual (`workflow_dispatch`)

Pașii CI includ:

1. PostgreSQL service
2. instalare `xmllint` (`libxml2-utils`)
3. `npm ci`
4. `prisma generate` + `prisma db push`
5. start backend
6. `npm run anaf:smoke -w backend`

Validare OpenAPI local:

```bash
npm run openapi:generate -w backend
npm run openapi:validate -w backend
```
