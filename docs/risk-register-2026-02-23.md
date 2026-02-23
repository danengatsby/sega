# Risk Register (C8-01)

Data creare: 23 Feb 2026  
Scop: registru de risc operabil si auditabil pentru capitolul 8 (`Analiza riscurilor si mitigare`), aliniat cu planul v3.0.

## Scara evaluare

- Probabilitate: `Scazuta (1)` / `Medie (2)` / `Ridicata (3)`
- Impact: `Mediu (1)` / `Ridicat (2)` / `Critic (3)`
- Scor risc: `Probabilitate x Impact` (interval `1..9`)
- Prioritate:
  - `High`: scor `>= 6`
  - `Medium`: scor `3..4`
  - `Low`: scor `1..2`

## Registru activ

| ID | Risc | Prob. | Impact | Scor | Prioritate | Owner | Mitigare | Trigger escalare | Monitorizare / Evidenta | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| R-01 | Modificari legislative ANAF (e-Factura, D406, D112) | 3 | 3 | 9 | High | Fiscal Compliance Owner | buffer backend 15-20%, update periodica mapari/validari XSD, smoke ANAF la fiecare schimbare | invalidari XML repetate sau reject ANAF > 0 intr-o luna | `.github/workflows/anaf-smoke.yml`, `apps/backend/src/services/reports/*` | OPEN |
| R-02 | Indisponibilitate API ANAF (upload/status/download) | 3 | 2 | 6 | High | Backend Lead | retry controlat, status tracking, fallback operational manual, comunicare catre utilizatori | > 3 erori consecutive pe flux e-Factura live | loguri `efactura`, dashboard operational | OPEN |
| R-03 | Degradare performanta la volum mare de date | 2 | 2 | 4 | Medium | Tech Lead | index tuning, view-uri materializate, bugete p95/p99 blocante in CI | p95 > target pe rute critice in 2 rulari consecutive | `.github/workflows/performance-kpi.yml`, `infra/prometheus/slo-alerts.yml` | OPEN |
| R-04 | Breach securitate (dependency/secret leak) | 1 | 3 | 3 | Medium | Security Champion | scan dependency + secret la fiecare PR, remediere accelerata HIGH/CRITICAL | orice vulnerabilitate HIGH/CRITICAL deschisa in branch de release | `.github/workflows/security-gates.yml` | OPEN |
| R-05 | Pierdere date / DR nereusit (RTO/RPO depasit) | 1 | 3 | 3 | Medium | DevOps Lead | drill lunar restore, backup criptat, validare row-count + raport drill | drill esuat sau RTO > 1h / RPO > 15m | `.github/workflows/dr-restore-drill.yml`, `docs/dr-runbook-restore.md` | OPEN |
| R-06 | Izolare multi-company incompleta (RLS/context) | 1 | 3 | 3 | Medium | Backend Lead | request context strict, `enforce_rls`, teste integration/e2e dedicate | orice evidenta de cross-company read/write | `apps/backend/src/middleware/db-context.integration.test.ts`, `apps/backend/src/routes/rbac-auth.e2e.test.ts` | OPEN |
| R-07 | Migrare date din sistem legacy cu diferente de reconciliere | 2 | 2 | 4 | Medium | Implementation Lead | dry-run ETL, reconciliere pe balanta/solduri, rulare paralela 1 luna | delta reconciliere > 0.01 RON | rapoarte reconciliere + semnare owner financiar | OPEN |
| R-08 | Rezistenta la adoptie (utilizare redusa module cheie) | 2 | 2 | 4 | Medium | PM + Product Owner | training pe rol, ghiduri, onboarding asistat, telemetrie adoptie modul | adoptie < 85% pe 2 luni consecutive | KPI business (BIZ-04), dashboard BI/adoptie | OPEN |
| R-09 | Dependenta de un singur dezvoltator (bus factor) | 2 | 2 | 4 | Medium | Tech Lead | rotatie ownership module critice, code review obligatoriu, documentare operationala | > 2 sprinturi fara reviewer secundar pe module critice | `docs/raci-tehnic-2026-02-23.md` + istoric PR | OPEN |
| R-10 | Workflow release incomplet (fara checklist) | 2 | 2 | 4 | Medium | PM + Tech Lead | template PR/release + gate soft/hard in CI | lipsa sectiuni obligatorii in PR body | `.github/workflows/release-checklist.yml`, `.github/pull_request_template.md` | MITIGATED |

## Ritual lunar de revizuire risc

Cadenta: lunar, in prima zi lucratoare (UTC+2), 60 minute.

Agenda minima:
1. Review top riscuri `High` + trend scor.
2. Verificare trigger-e escalare aparute in ultima luna.
3. Status actiuni de mitigare (ce s-a inchis / ce a intarziat).
4. Actualizare owner / termen pentru riscuri noi sau mutate.
5. Decizie de escalare catre management (daca este cazul).

## Template minuta review risc

```text
Risk Review Minute
Date: YYYY-MM-DD
Chair: <nume>
Participanti: <lista>

1) Top High risks:
- R-XX: <status, trend, decizie>

2) Trigger events:
- <eveniment> -> <actiune>

3) Actiuni noi:
- [owner] [deadline] [deliverable]

4) Escalari:
- <da/nu> + motiv
```

## Calendar propus (date absolute)

- Review #1: 2 March 2026
- Review #2: 1 April 2026
- Review #3: 4 May 2026

## Criteriu de inchidere C8-01

- Registru de risc publicat si versionat in repo.
- Cel putin un ciclu lunar completat cu minuta + actiuni de follow-up.
- Corelare risc-alarma evidentiata pentru riscurile tehnice (performanta, securitate, DR).
