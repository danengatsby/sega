# XBRL XSD (SEGA)

Acest folder conține schema țintă pentru exportul anual XBRL:

- `sega-xbrl-instance.xsd` - schema instanță (rădăcină `xbrli:xbrl`)
- `sega-financial-statements-2026.xsd` - taxonomie SEGA pentru situațiile financiare anuale

Validare locală:

```bash
xmllint --noout --schema apps/backend/xbrl/xsd/sega-xbrl-instance.xsd <fisier>.xbrl
```
