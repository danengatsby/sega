# Plan de Inchidere Conformitate Partiala (v3.0)

Data: 23 Feb 2026  
Intrare: `docs/raport-final-conformitate-2026-02-23.md`  
Scop: inchiderea capitolelor marcate `PARȚIAL` prin livrabile verificabile.

## Domeniu

Capitole tintite:
- 1. Viziunea si obiectivele strategice
- 4. Planul de implementare pe faze
- 5. Resurse, echipa, structura organizationala
- 8. Analiza riscurilor si mitigare
- 9. KPI si criterii de succes
- 11. Concluzie si recomandari finale

## Status implementare (actualizat la 23 Feb 2026)

- `C1-01`: livrat (`docs/kpi-business-dictionary-2026-02-23.md`).
- `C4-01`: livrat (`docs/traceability-matrix-2026-02-23.md`).
- `C4-02`: livrat (workflow `.github/workflows/release-checklist.yml` + template `.github/pull_request_template.md`).
- `C5-01`: livrat (`docs/raci-tehnic-2026-02-23.md` - include politica code review si setari recomandate branch protection).
- `C8-01`: livrat (`docs/risk-register-2026-02-23.md`).
- `C9-01`: livrat baseline (`.github/workflows/business-kpi-monthly.yml` + `apps/backend/scripts/compliance/generate-monthly-kpi-report.ts`).
- `C11-01`: livrat baseline (`docs/executive-review-2026-Q1.md` + `docs/adr-index-2026-02-23.md` + `docs/adr/*`).

## Principii de executie

- Fiecare capitol partial este mapat pe artefacte concrete (document, dashboard, raport, workflow).
- Orice obiectiv business trebuie sa aiba formula de calcul + sursa de date + frecventa + owner.
- Nu se inchide un capitol fara dovada executabila (query, export, screenshot dashboard, workflow run).

## Plan pe capitole

### Capitol 1 (Viziune/obiective)

Obiectiv: operationalizare KPI business mentionati in plan (eficienta, conformitate, uptime SLA, ROI).

Task-uri:
- Definire dictionar KPI business in document dedicat (`docs/kpi-business-dictionary-2026-02-23.md`).
- Adaugare colectare pentru:
  - timp mediu procesare document
  - rata utilizare module cheie
  - rata submit e-Factura in termen
- Dashboard business in UI sau Grafana cu seria temporala pentru KPI-urile de mai sus.

DoD:
- Formula + sursa + owner pentru fiecare KPI.
- Date disponibile pe minim 30 zile in mediul de productie/staging.

### Capitol 4 (Plan implementare faze)

Obiectiv: trasabilitate livrabile pe sprint/faza.

Task-uri:
- Matrice de trasabilitate `capitol plan -> issue/PR/test/doc` in `docs/traceability-matrix-2026-02-23.md`.
- Template release note obligatoriu cu sectiuni:
  - livrabile faza
  - regression risks
  - verificari post-release
- Workflow GitHub pentru validare checklist release (gate soft initial, hard gate dupa 2 sprinturi).

DoD:
- Fiecare release are checklist complet + linkuri catre PR-uri/teste.

### Capitol 5 (Resurse/organizare)

Obiectiv: operationalizare guvernanta tehnica minima.

Task-uri:
- Definire RACI tehnic pentru:
  - productie incident response
  - conformitate fiscala
  - schimbari de schema DB
- Politica obligatorie de code review (minimum 1 reviewer, exceptii documentate).
- Rotatie ownership pentru module critice (auth, invoices, reports, open-banking).

DoD:
- Document RACI aprobat + politica review activa in repo settings.

### Capitol 8 (Riscuri/mitigare)

Obiectiv: registru de risc operabil si auditabil.

Task-uri:
- Creare `docs/risk-register-2026-02-23.md` cu:
  - probabilitate/impact
  - owner
  - plan de mitigare
  - trigger de escalare
- Ritual lunar de revizuire risc (minuta + actiuni).
- Corelare riscuri tehnice cu alerte Prometheus/Alertmanager unde aplicabil.

DoD:
- Minim un ciclu lunar complet (revizuire + follow-up).

### Capitol 9 (KPI/criterii succes)

Obiectiv: inchidere KPI business neoperationalizati.

Task-uri:
- Implementare raport lunar automat pentru:
  - NPS
  - rata adoptare functionalitati
  - timp onboarding contabil nou
  - erori de conformitate fiscala
- Definire metoda calcul ROI si amortizare (input: costuri proiect, costuri operationale, amenzi evitate).
- Publicare dashboard KPI business + target vs actual.

DoD:
- Raport lunar generat automat + distributie stakeholderi.

### Capitol 11 (Concluzii/recomandari)

Obiectiv: inchidere bucla de imbunatatire continua.

Task-uri:
- Document trimestrial `docs/executive-review-YYYY-QN.md`:
  - stadiu conformitate
  - variatii KPI
  - recomandari actionabile pe urmatorul trimestru
- Lista de decizii arhitecturale cu impact business (ADR index).

DoD:
- Un ciclu trimestrial complet cu decizii urmarite pana la rezultat.

## Milestones propuse (date absolute)

- Milestone 1 (31 March 2026): KPI dictionary + traceability matrix + RACI.
- Milestone 2 (30 April 2026): risk register operational + dashboard KPI business v1.
- Milestone 3 (31 May 2026): primul raport lunar complet + executive review Q2 2026 draft.
- Milestone 4 (30 June 2026): reevaluare conformitate si reclasificare capitole partiale.

## Evidente minime pentru reevaluare

- Link dashboard (Grafana/UI) cu serii KPI.
- Export raport lunar KPI business.
- Run-uri workflow release checklist.
- Risk register cu istoric actualizari.
- Executive review trimestrial.
