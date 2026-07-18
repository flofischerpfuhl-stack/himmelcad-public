# ADR 0012: Explizite PhotoLab-Produkt-Lineage

## Status

Angenommen

## Kontext

Ein PhotoLab-Projekt kann mehrere Ausrichtungen mit unterschiedlichen, unveränderlichen
Kameramengen enthalten. Eine globale Auswahl des lexikografisch neuesten Zwischenprodukts kann
dadurch Tiefenbilder, Punktwolken, Raster oder Meshes verschiedener Flüge unbemerkt mischen.

## Entscheidung

- Ein optional gewählter `ProcessingSet` wird vor dem Produktstart aus dem Object Store gelesen,
  über seinen Membership-Hash validiert und auf existierende Kamera-Entities geprüft.
- Als Quellausrichtung gilt ausschließlich die neueste veröffentlichte Sparse-Ausrichtung, deren
  sortierte Kameramenge exakt der eingefrorenen Menge entspricht.
- Produkt-only-Batches verwenden analog ihre exakte Batch-Kameramenge. Eine leere Batch-Auswahl
  bedeutet explizit alle momentan importierten Kameras, nicht irgendeine letzte Ausrichtung.
- Neue MVS-, Gaussian-Splat-, Raster- und Mesh-Records speichern die
  `sourceAlignmentEntityId` sowie die optionale `processingSetId` und validieren beide Referenzen
  vor der atomaren Publikation.
- Dichte Punktwolken, DEMs, Orthomosaike und Texturen werden nur als Abhängigkeit akzeptiert, wenn
  beide Lineage-Felder mit dem aktuellen Lauf übereinstimmen. Ältere Records ohne Lineage bleiben
  darstell- und exportierbar, werden aber nicht still als neue Compute-Abhängigkeit verwendet.
- Die Lineage ist Bestandteil der Job-Input-Hashes und damit der Batch-/Recovery-Identität.
- Mehrere Flüge werden nicht durch einen globalen Scope oder den neuesten Lauf zusammengeführt.
  Ein gemeinsames Produkt referenziert nach ADR 0014 einen atomar veröffentlichten
  `MergedAlignmentRun`, der seine Eingangsausrichtungen, GCP-Optimierungen und
  Verbindungsevidenz vollständig festhält. Ein nur geplanter Merge ist keine Produktquelle.

## Konsequenzen

Ein neuerer Lauf eines anderen Verarbeitungssatzes kann einen bestehenden Produktgraphen nicht
mehr beeinflussen. Fehlt ein kompatibles Zwischenprodukt, bricht die Vorbereitung mit einer
konkreten Fehlermeldung ab und verlangt dessen erneute Berechnung. Das ist absichtlich strenger
als eine automatische globale Fallback-Auswahl.
