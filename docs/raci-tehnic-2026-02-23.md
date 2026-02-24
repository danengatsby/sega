# RACI Tehnic + Politica Code Review (C5-01)

Data creare: 23 Feb 2026  
Scop: operationalizare capitol 5 (`Resurse, echipa, structura organizationala`) pentru procesele tehnice critice.

## Roluri

- `TL` - Tech Lead / Arhitect software
- `BL` - Backend Lead
- `FE` - Frontend Lead
- `DO` - DevOps / Infrastructure
- `QA` - QA Engineer
- `FC` - Fiscal Compliance Owner (consultant contabil/fiscal)
- `PM` - Project Manager

## Matrice RACI

### 1) Incident response productie

| Activitate | TL | BL | FE | DO | QA | FC | PM |
|---|---|---|---|---|---|---|---|
| Detectie incident (alerting, triage initial) | C | R | C | A/R | C | I | I |
| Stabilizare serviciu (mitigare rapida) | A | R | C | R | C | I | I |
| Decizie rollback/hotfix | A | R | C | R | C | I | C |
| Comunicare stakeholderi | C | I | I | C | I | I | A/R |
| Postmortem + actiuni preventive | A | R | C | R | R | C | C |

### 2) Conformitate fiscala (ANAF/e-Factura/declaratii)

| Activitate | TL | BL | FE | DO | QA | FC | PM |
|---|---|---|---|---|---|---|---|
| Interpretare schimbari legislatie | I | C | I | I | I | A/R | C |
| Implementare schimbari tehnice | A | R | C | C | C | C | I |
| Validare fiscala functionalitate | C | C | I | I | C | A/R | I |
| Smoke/Regression pe flux fiscal | C | R | I | C | A/R | C | I |
| Aprobare release fiscal | C | C | I | I | C | A | R |

### 3) Schimbari schema DB (migrari, RLS, integritate)

| Activitate | TL | BL | FE | DO | QA | FC | PM |
|---|---|---|---|---|---|---|---|
| Design schema/migrare | A | R | I | C | C | C | I |
| Review impact performanta/securitate | A | R | I | C | C | I | I |
| Plan rollout + rollback | A | R | I | R | C | I | C |
| Validare pre/post deployment | C | R | I | R | A | I | I |
| Semnare finala schimbare | A | R | I | C | C | I | I |

## Rotatie ownership module critice

Cadenta: lunara (prima saptamana din luna).

| Modul critic | Owner primar | Backup owner | Frecventa rotatie | Evidenta |
|---|---|---|---|---|
| `auth` | BL | TL | Lunar | minuta tehnica sprint planning |
| `invoices` | BL | FC | Lunar | release notes + PR review log |
| `reports` | TL | QA | Lunar | backlog board + test reports |
| `open-banking` | BL | DO | Lunar | runbook operational + smoke logs |

## Politica obligatorie de code review

### Reguli

1. Orice PR catre `main/master` necesita minimum `1` review aprobat de un contributor diferit de autor.
2. PR-urile cu impact critic (auth, fiscal, DB schema, RLS, security) necesita `2` aprobari recomandat.
3. Autorul PR nu poate auto-aproba propria schimbare.
4. PR-ul trebuie sa contina:
   - sectiune `Livrabile faza`
   - sectiune `Regression risks`
   - sectiune `Verificari post-release`
5. Exception handling (hotfix urgent):
   - merge permis cu `0` aprobari doar daca incidentul este `SEV-1`;
   - post-review obligatoriu in max `24h`;
   - retro + actiune preventiva obligatorie.

### Implementare operationala in repo

- Template PR/release: `.github/pull_request_template.md`
- Gate checklist release (soft/hard): `.github/workflows/release-checklist.yml`
- Gates tehnice existente: `security-gates`, `openapi-contract`, `performance-kpi`, `frontend-tests`, `dr-restore-drill`, `observability-config`

### Setari recomandate in GitHub (branch protection)

1. `Require a pull request before merging`: ON
2. `Require approvals`: `>= 1` (recomandat `>= 2` pentru module critice)
3. `Dismiss stale pull request approvals when new commits are pushed`: ON
4. `Require status checks to pass before merging`: ON (include `Release Checklist` + gates tehnice)
5. `Require conversation resolution before merging`: ON

## Evidente minime pentru C5-01

- Document RACI publicat in repo.
- Politica code review publicata si referentiata in workflow/template PR.
- Minim un release/PR validat prin `release-checklist.yml` + review aprobat.
