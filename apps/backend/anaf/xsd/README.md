# ANAF XSD Setup

Pentru validare XSD locala "ready for SPV", pune in acest director schemele oficiale ANAF:

- `d300.xsd`
- `d394.xsd`
- `d112.xsd`
- `d406.xsd`

Conditii:

1. Configureaza in `apps/backend/.env`:
   - `ANAF_XSD_DIR=./anaf/xsd`
   - `ANAF_VALIDATE_XSD=true`
2. Instaleaza local `xmllint` (libxml2).
3. Ruleaza exporturile ANAF cu `validate=true` sau lasa validarea implicita activa prin env.

Note:

- D112 publicat pe ANAF are mai multe variante cu erori de sintaxa XML. In acest proiect `d112.xsd` trebuie sa fie o varianta oficiala valida XML (curent: `d112_06022020.xsd`).
- Daca schema nu exista sau `xmllint` nu e instalat, exportul se face in continuare, dar raspunsul include warnings.
- Pentru depunere in SPV, foloseste intotdeauna schemele oficiale actualizate si valide.
