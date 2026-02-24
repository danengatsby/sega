# DR Runbook Restore (SEGA)
Data: 24 februarie 2026

## Obiectiv
Validare periodică backup/restore pentru PostgreSQL cu ținte:
- `RTO < 1h`
- `RPO < 15m`

## Prerechizite
- `DATABASE_URL` valid către baza sursă.
- Tooling instalat: `pg_dump`, `pg_restore`, `psql`, `node`.
- Permisiuni DB pentru creare/distrugere bază de test restore.

## Comenzi standard
```bash
npm run dr:backup
npm run dr:restore -- --backup-file apps/backend/dr/backups/<fisier>.dump --target-db sega_restore_test
npm run dr:drill
```

## Ce face drill-ul
1. Rulează backup custom-format (`pg_dump`).
2. Calculează checksum SHA256 și metadata.
3. Restaurează într-o bază izolată (`sega_restore_test` implicit).
4. Compară `count(*)` pentru toate tabelele din schema `public`.
5. Generează raport JSON:
   - `apps/backend/dr/reports/restore-drill-*.json`

## Criterii PASS
- `mismatchedTables = 0`
- `rtoSeconds <= DR_RTO_TARGET_SECONDS` (default `3600`)
- `rpoSeconds <= DR_RPO_TARGET_SECONDS` (default `900`)

## CI/CD
Workflow: `.github/workflows/dr-restore-drill.yml`
- rulare manuală (`workflow_dispatch`)
- rulare lunară (`cron: 0 3 1 * *`)

Artefacte CI:
- metadata backup (`apps/backend/dr/backups/*.metadata.json`)
- report drill (`apps/backend/dr/reports/restore-drill-*.json`)
