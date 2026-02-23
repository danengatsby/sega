# Traceability Matrix (Plan v3.0 -> issue/PR/test/doc)

Data: 23 Feb 2026  
Scop: trasabilitate executabila pentru capitolele planului v3.0, cu mapare explicita `capitol -> issue/backlog -> PR/commit -> test/CI -> document`.

## Conventii

- `Issue/Backlog`: ID-uri din `docs/gap-backlog-2026-02-22.md` (P0/P1/P2) + work-item-uri de inchidere partiala (`C*`).
- `PR/Commit`: hash commit local (git history).
- `Test/CI`: test automat sau workflow care valideaza cerinta.
- `Doc`: evidenta functionala/compliance.

## Work items de inchidere partiala (`C*`)

| ID | Capitol | Deliverable | Status |
|---|---|---|---|
| C1-01 | 1 | KPI business dictionary | LIVRAT |
| C4-01 | 4 | Traceability matrix | LIVRAT |
| C4-02 | 4 | Release checklist workflow | LIVRAT |
| C5-01 | 5 | RACI tehnic + policy review obligatoriu | LIVRAT |
| C8-01 | 8 | Risk register operational | LIVRAT |
| C9-01 | 9 | Raport lunar KPI business automat | LIVRAT (baseline workflow+script) |
| C11-01 | 11 | Executive review trimestrial + ADR index | LIVRAT (baseline documentar) |

## Matrice pe capitole

| Capitol plan | Issue/Backlog | PR/Commit | Test/CI | Doc | Status |
|---|---|---|---|---|---|
| 1. Viziune si obiective strategice | C1-01, C9-01, P1-07 | `de54451`, `80fd4b1` | `apps/backend/src/routes/reports-dashboard-bi.integration.test.ts`, `.github/workflows/business-kpi-monthly.yml` | `docs/raport-final-conformitate-2026-02-23.md`, `docs/kpi-business-dictionary-2026-02-23.md`, `docs/reports/kpi-business-report-YYYY-MM.md` | PARTIAL |
| 2. Arhitectura tehnica | P1-01, P2-01 | `1fd7c32`, `2f2d4d7` | `.github/workflows/openapi-contract.yml`, `apps/backend/src/microservices/auth-service-app.test.ts`, `apps/backend/src/microservices/invoice-service-app.test.ts` | `README.md`, `docs/microservices-transition-roadmap-2026-02-22.md` | ACOPERIT |
| 3. Module functionale | P0-04, P0-05, P0-06, P1-04, P1-05, P1-06, P1-07, P1-08 | `1fd7c32` | `apps/backend/src/routes/journal-workflow.integration.test.ts`, `apps/backend/src/routes/revisal.integration.test.ts`, `apps/backend/src/routes/reports-d406.integration.test.ts`, `apps/backend/src/routes/reports-xbrl.integration.test.ts` | `README.md`, `docs/gap-backlog-2026-02-22.md` | ACOPERIT |
| 4. Plan implementare pe faze | C4-01, C4-02, P0-P2 backlog tracking | `de54451`, `80fd4b1` | CI existent pentru quality gates (`openapi-contract`, `security-gates`, `performance-kpi`) + `.github/workflows/release-checklist.yml` | `docs/gap-backlog-2026-02-22.md`, `docs/plan-inchidere-conformitate-partiala-2026-02-23.md`, `docs/traceability-matrix-2026-02-23.md`, `.github/pull_request_template.md` | PARTIAL |
| 5. Resurse/organizare | P0-03, C5-01 | `1fd7c32` | `apps/backend/src/routes/rbac-auth.e2e.test.ts`, `apps/backend/src/middleware/rbac-endpoints.integration.test.ts`, `.github/workflows/release-checklist.yml` | `README.md`, `docs/plan-inchidere-conformitate-partiala-2026-02-23.md`, `docs/raci-tehnic-2026-02-23.md` | PARTIAL |
| 6. Cerinte nefunctionale (SLA/perf/sec) | P0-01, P0-08, P2-02, P2-03, P2-05 | `1fd7c32` | `.github/workflows/performance-kpi.yml`, `.github/workflows/security-gates.yml`, `.github/workflows/dr-restore-drill.yml`, `.github/workflows/observability-config.yml` | `docs/dr-runbook-restore.md`, `docs/incident-response-runbook.md` | ACOPERIT |
| 7. Integrari externe + legal | P0-07, P1-02, P1-03, P1-04, P1-05, P1-06 | `44a506b`, `1fd7c32` | `apps/backend/src/routes/bank-reconciliation-file-import.integration.test.ts`, `apps/backend/src/services/efactura-service.test.ts`, `apps/backend/src/services/open-banking/pilot-bcr-connector.test.ts`, `.github/workflows/anaf-smoke.yml` | `README.md`, `docs/gap-backlog-2026-02-22.md` | ACOPERIT |
| 8. Riscuri si mitigare | C8-01, P2-05 | `de54451` | Alerting config + runbook drills (`observability-config`, `dr-restore-drill`) | `docs/incident-response-runbook.md`, `docs/plan-inchidere-conformitate-partiala-2026-02-23.md`, `docs/risk-register-2026-02-23.md` | PARTIAL |
| 9. KPI si criterii succes | C9-01, C1-01, P2-02 | `de54451` | `.github/workflows/performance-kpi.yml` (KPI tehnici), `.github/workflows/business-kpi-monthly.yml` (KPI business) | `docs/raport-final-conformitate-2026-02-23.md`, `docs/kpi-business-dictionary-2026-02-23.md`, `apps/backend/scripts/compliance/generate-monthly-kpi-report.ts` | PARTIAL |
| 10. Stiva tehnologica | P1-01, P0-08, P2-05 | `1fd7c32` | `.github/workflows/frontend-tests.yml`, `.github/workflows/openapi-contract.yml`, `.github/workflows/security-gates.yml` | `README.md` | ACOPERIT |
| 11. Concluzie si recomandari | C11-01 | `80fd4b1`, `de54451` | N/A (document de guvernanta) | `docs/raport-final-conformitate-2026-02-23.md`, `docs/plan-inchidere-conformitate-partiala-2026-02-23.md`, `docs/executive-review-2026-Q1.md`, `docs/adr-index-2026-02-23.md` | PARTIAL |

## Matrice faze (plan -> backlog -> evidenta)

| Faza plan | Scope faza | Issue/Backlog | PR/Commit | Test/CI | Doc |
|---|---|---|---|---|---|
| Faza 1 (fundament contabil) | auth, RBAC, plan conturi, jurnal, rapoarte baza | P0-01..P0-04 | `1fd7c32`, `2f2d4d7` | `auth-security.e2e`, `rbac-auth.e2e`, `journal-workflow.integration` | `README.md`, `docs/gap-backlog-2026-02-22.md` |
| Faza 2 (flux comercial) | parteneri, facturi, plati, trezorerie, reconciliere | P1-02, P1-03 | `44a506b`, `1fd7c32` | `bank-reconciliation-file-import.integration`, `open-banking:smoke` | `README.md`, `docs/gap-backlog-2026-02-22.md` |
| Faza 3 (conformitate fiscala) | salarii, D112, mijloace fixe, D300/D394, SAF-T | P0-06, P1-04, P1-05 | `1fd7c32` | `anaf-service.d112.test`, `reports-d406.integration`, `revisal.integration` | `README.md`, `docs/gap-backlog-2026-02-22.md` |
| Faza 4 (BI/raportare avansata) | dashboard KPI, forecast, XBRL, comparatii | P1-06, P1-07 | `1fd7c32` | `reports-dashboard-bi.integration`, `reports-xbrl.integration` | `README.md`, `docs/gap-backlog-2026-02-22.md` |
| Faza 5 (optimizare + go-live readiness) | performanta, securitate, DR, observabilitate | P0-08, P2-02, P2-03, P2-05 | `1fd7c32` | `performance-kpi`, `security-gates`, `dr-restore-drill`, `observability-config` | `docs/dr-runbook-restore.md`, `docs/incident-response-runbook.md` |

## Gaps ramase pentru inchidere capitole PARTIAL

1. Rulare operationala C9-01: lipseste primul artifact generat in CI/schedule si distributia stakeholderilor.
2. Rulare operationala C11-01: lipseste executive review Q2 2026 cu urmarirea efectelor ADR.
