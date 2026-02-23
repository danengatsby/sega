# SEGA Gap Backlog (P0/P1/P2)

Data: 2026-02-22  
Scop: inchidere gap-uri intre implementarea curenta SEGA (MVP) si planul profesional v3.0.

## Rezumat

Acest backlog este orientat pe executie si prioritizat in:
- P0: conformitate, securitate, corectitudine contabila.
- P1: capabilitati functionale majore lipsa.
- P2: scalare enterprise si operare avansata.

Estimare totala: 12-16 sprinturi (2 saptamani/sprint), in functie de alocare echipa.

## P0 (Critic)

| ID | Gap | Capitol plan | Task executabil | Estimare | Criteriu de acceptare |
|---|---|---|---|---|---|
| P0-01 | Rate limiting definit in env, dar neaplicat efectiv | 2.3.1, 6.3 | Integrare `express-rate-limit` pe API public + regula separata pe `/api/auth/login` | 0.5 sprint | 100 req/min public, 10 req/min login, teste automate 429 |
| P0-02 | MFA incomplet (fara setup/verify in flux real) | 2.3.2 | Endpoint-uri MFA (`setup`, `verify`, `disable`), challenge la login pentru roluri critice, enforcement global | 1 sprint | ADMIN/CHIEF_ACCOUNTANT nu pot opera fara MFA activ |
| P0-03 | RLS existent in SQL, dar context request nefortat strict | 1.3 (Single Source, Audit First), 5.2 | Middleware DB context (`set_request_context`), blocare request fara `companyId`, teste izolare multi-company | 1 sprint | Niciun query cross-company in teste de integrare |
| P0-04 | Flux jurnal incomplet vs schita (status, numerotare NC, storno controlat) | 3.1.2 | Introducere statusuri `DRAFT/VALIDATED/CLOSED`, numerotare `NC-AAAA-NNNNNN`, endpoint storno cu legatura nota originala | 1.5 sprint | Nota neechilibrata nu poate fi validata; storno genereaza nota inversa |
| P0-05 | Proforma/storno nu au reguli contabile stricte dedicate | 3.2.1 | Reguli explicite: PROFORMA fara postare contabila; STORNO doar inversare document sursa | 0.5 sprint | Teste business pe tip document trec (unit + integration) |
| P0-06 | Payroll fara CAM in model/totals/export | 3.3.1 | Extindere schema payroll cu CAM (2.25%), calcul + postare contabila + includere in export D112 | 1 sprint | CAM apare in state, jurnal si XML D112 |
| P0-07 | e-Factura semnata arhivata local, nu obiect storage | 7.1 | Persistenta XML semnat in MinIO (S3), link de acces intern, fallback robust | 0.5 sprint | Fisierele nu mai sunt salvate local pe disk |
| P0-08 | CI fara gate-uri securitate enterprise | 6.3, 9.1 | Pipeline minim: dependency scan + secret scan + praguri blocante la severitate ridicata | 1 sprint | Build blocat la HIGH/CRITICAL conform politica |

Durata P0: ~7-8 sprinturi.

Status actualizare 2026-02-23 (implementare cod):
- P0-01 (`Rate limiting`) este acoperit prin reguli active pe `/api/auth/login` și `/api/auth/*` (limite 10/min respectiv 100/min) + teste automate 429.
- P0-02 (`MFA`) este acoperit end-to-end (`setup/verify/disable`, challenge login, enforcement global), cu roluri critice `ADMIN` și `CHIEF_ACCOUNTANT`.
- P0-03 (`RLS + request context`) este acoperit prin middleware DB context request-scoped + `set_request_context` și `enforce_rls` forțat pe request.
- P0-04 (`Flux jurnal`) este acoperit prin statusuri `DRAFT/VALIDATED/CLOSED`, numerotare `NC-AAAA-NNNNNN`, storno controlat cu legătură la nota sursă și teste de integrare.
- P0-05 (`Reguli PROFORMA/STORNO`) este acoperit: PROFORMA fără postare contabilă, STORNO permis doar pe sursă `FISCAL`, cu teste business dedicate.
- P0-06 (`Payroll CAM`) este acoperit în calcul state, postare contabilă și export D112 (`datCAM`, `bifa_CAM`), cu test dedicat.
- P0-07 (`e-Factura storage`) este acoperit prin persistență XML semnat în obiect storage S3-compatible (MinIO) și acces intern prin cheie stocată.
- P0-08 (`Security gates CI`) este acoperit prin workflow dedicat cu scan dependency + secret și prag blocant `HIGH/CRITICAL`.

## P1 (Major)

| ID | Gap | Capitol plan | Task executabil | Estimare | Criteriu de acceptare |
|---|---|---|---|---|---|
| P1-01 | Fara OpenAPI 3.0 | 1.3 (API-First) | Generare spec OpenAPI + publicare `/api/docs` + validare contract in CI | 1 sprint | 100% endpoint-uri critice documentate |
| P1-02 | Import extrase doar JSON intern (fara parser MT940/CAMT) | 1.2.1, 7.2 | Parser MT940 + CAMT.053 + CSV, mapping validat, endpoint upload fisier | 1.5 sprint | Import 500 tranzactii < 15s, reconciliere functionala |
| P1-03 | Lipsa integrare Open Banking PSD2 reala | 7.2 | Conector pilot (o banca), OAuth2, sync sold/tranzactii | 2 sprinturi | Sync incremental zilnic + monitorizare erori |
| P1-04 | D406 SAF-T in format simplificat MVP | 4.3 (S18), 7.3 | Implementare structura SAF-T extinsa (master + entries + source docs) | 2 sprinturi | Validare XSD SAF-T fara erori |
| P1-05 | Lipsa Revisal end-to-end | 4.3 (S14), 7.3 | Export Revisal XML + flux operational de livrare | 1 sprint | Export conform si utilizabil operational |
| P1-06 | Lipsa export XBRL | 4.4 (S19), 7.3 | Export XBRL pentru situatii financiare anuale | 1.5 sprint | Fisier XBRL valid pe schema tinta |
| P1-07 | Dashboard BI limitat, fara alerte/forecast 30-60-90 complet | 1.2.3, 4.4 | KPI extinsi, forecast cashflow, alerte configurabile (scadente/restante) | 1.5 sprint | KPI si alerte disponibile din UI |
| P1-08 | Lipsa notificari sistematice (email/SMS/push) | 2.2, 4.4 | Notification worker + template-uri + event hooks | 1 sprint | Notificari trimise la evenimente cheie |

Durata P1: ~11-12 sprinturi.

Status actualizare 2026-02-23 (implementare cod):
- P1-01 (`Fără OpenAPI 3.0`) este acoperit prin generare automată OpenAPI 3.0, publicare `/api/docs`, validare contract în CI (main + service contracts) și gate de drift pentru artefactele generate.
- P1-02 (`Import extrase MT940/CAMT/CSV`) este acoperit prin endpoint upload `POST /api/bank-reconciliation/statements/import-file`, parser dedicat `MT940/CAMT053/CSV`, validări de mapare și teste automate (inclusiv benchmark 500 tranzacții sub pragul operațional de 15s + reconciliere end-to-end pentru toate formatele).
- P1-03 (`Integrare Open Banking PSD2 pilot`) este acoperit prin conector pilot BCR (`OAuth2` token exchange + refresh), sincronizare incrementală sold/tranzacții (`manual` + `scheduler` zilnic), monitorizare erori (`status ERROR`, `errorCount`, `lastErrorMessage`) și smoke test end-to-end (`npm run open-banking:smoke`) validat.
- P1-04 (`D406 SAF-T`) este acoperit prin structură extinsă `MasterFiles + GeneralLedgerEntries + SourceDocuments`, mapări stricte și validare XSD locală (inclusiv fix pentru lifecycle fișier temp în validator).
- P1-05 (`Lipsa Revisal end-to-end`) este acoperit prin rute dedicate export/livrare, persistență `RevisalDelivery` și validare XSD locală.
- P1-06 (`Lipsa export XBRL`) este acoperit prin endpoint-ul `GET /api/reports/export/financial.xbrl`, generare anuală XBRL și validare pe schema locală țintă.
- P1-07 (`Dashboard BI limitat`) este acoperit prin endpoint-ul `GET /api/reports/dashboard-bi` (forecast cashflow 30/60/90, alerte configurabile scadențe/restanțe și analiză comparativă explicită `luna curentă vs luna anterioară vs aceeași lună din anul precedent`) expus în UI.
- P1-08 (`Lipsa notificări sistematice`) este acoperit prin `notification worker` (Bull + fallback memorie), template-uri multi-canal și event hooks pe facturi, plăți, payroll și Revisal, validate prin teste dedicate pe template-uri + resolver/config.
- P2-01 (`Monolit, fără tranziție spre microservicii`) este acoperit în faza 1 prin extragerea `auth-service` și `invoice-service`, fiecare cu runtime separat și contract OpenAPI dedicat.
- P2-02 (`KPI tehnici de performanță`) este acoperit operațional prin suite `k6` + `JMeter`, praguri p95/p99 blocante în CI (`performance-kpi.yml`) și tuning DB/indexuri în `enterprise-hardening.sql`.
- P2-03 (`RTO/RPO/DR neautomatizate complet`) este acoperit prin scripturi automate de backup/restore (`pg_dump`/`pg_restore`), drill de restore cu validare date și workflow lunar `dr-restore-drill.yml`.
- P2-04 (`Control conformitate avansată`) este acoperit prin job retention audit log (10 ani), politică explicită acces audit pe roluri configurabile și raport verificabil (`/api/compliance/report` + trigger manual `/api/compliance/retention/run`).
- P2-05 (`Observabilitate enterprise parțială`) este acoperit prin dashboard Grafana SLO, reguli/alerte on-call în Prometheus+Alertmanager și runbook de incident response (`docs/incident-response-runbook.md`).

## P2 (Enterprise Scale)

| ID | Gap | Capitol plan | Task executabil | Estimare | Criteriu de acceptare |
|---|---|---|---|---|---|
| P2-01 | Monolit, fara tranzitie spre microservicii | 2.2 | Separare progresiva pe domenii (auth/accounting/invoice/reporting) cu contracte API clare | 3 sprinturi | Min. 2 servicii extrase fara regresii |
| P2-02 | KPI tehnici de performanta neacoperiti operational | 6.1, 9.1 | Teste k6/JMeter + tuning DB/indexuri + bugete p95/p99 | 2 sprinturi | p95 API < 300ms pe rutele tinta |
| P2-03 | RTO/RPO/DR neautomatizate complet | 6.2 | Proceduri backup/restore automate + exercitiu lunar restore | 1.5 sprint | Test restore lunar 100% reusit |
| P2-04 | Control conformitate avansata incomplet (GDPR retention, audit ops) | 1.2.2, 7.3 | Job retention 10 ani, politici acces audit, raport conformitate | 1 sprint | Politici active si verificabile |
| P2-05 | Observabilitate enterprise partiala | 6, 9 | SLO dashboard, alerte on-call, runbook incident response | 1 sprint | SLO uptime/latenta monitorizate continuu |

Durata P2: ~8-9 sprinturi.

## Plan de executie recomandat

1. Sprinturi 1-4: P0-01..P0-04  
2. Sprinturi 5-8: P0-05..P0-08  
3. Sprinturi 9-14: P1-01..P1-04  
4. Sprinturi 15-20: P1-05..P1-08  
5. Sprinturi 21+: P2 (in functie de obiective comerciale)

## KPI de tracking backlog

| KPI | Tinta |
|---|---|
| Inchidere P0 | <= 8 sprinturi |
| Defecte critice pe module P0 | 0 in UAT |
| Acoperire teste automate backend | >= 80% |
| Timp mediu remediere issue de conformitate | < 5 zile |
| Rata task-uri finalizate per sprint | >= 85% |
