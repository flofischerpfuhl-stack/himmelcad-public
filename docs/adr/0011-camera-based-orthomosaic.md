# ADR 0011: DEM-gestützte kamera-basierte Orthomosaike

- Status: entschieden und implementiert
- Datum: 2026-07-11

## Entscheidung

PhotoLab erzeugt Orthomosaike aus den entzerrten Originalbildern, den finalen
Kameramodellen und einem bereits publizierten DEM. RGB-Werte einer dichten
Punktwolke sind kein Orthomosaik-Backend und werden dafür nicht mehr verwendet.

Die Orthorektifizierung arbeitet in festen 512-Pixel-Kacheln. Pro Kachel werden
nur überlappende Kameras berücksichtigt, auf höchstens 16 Kandidaten begrenzt
und aus einem größenbegrenzten LRU-Bildcache geladen. Jeder Kartenpixel wird am
DEM abgetastet, in die Kandidatenkameras projiziert und bilinear aus dem
entzerrten Bild gelesen. Der User kann zwischen bester Blickgeometrie,
gewichteter Mittelung und der ersten geeigneten Kamera wählen. Optional werden
eine begrenzte Farbangleichung und kleine Ein-Pixel-Lücken angewandt.

Jede erzeugte Quellkachel erhält vor dem bestehenden GDAL-Pfad eine explizite
Georeferenzierung. Danach bleiben COG-Erzeugung, Rasterpyramide, 2D-Streaming,
3D-Texturierung, Checkpoints und atomare Publikation unverändert.

## Invarianten

- Das DEM ist ein expliziter, unveränderlicher Input des Orthomosaik-Jobs.
- Kameras und DEM müssen im selben projektierten Projektkoordinatenraum liegen.
- Keine Netzwerkzugriffe und keine implizite CRS-Transformation.
- Abbruch wird mindestens je 16 Bildzeilen und während jedes GDAL-Prozesses
  geprüft; partielle Ergebnisse bleiben im transienten Staging.
- Arbeits-RAM hängt von Kachel- und Cachebudget ab, nicht von der gesamten
  Projekt- oder Orthomosaikgröße.

## Noch nicht als Funktion behauptet

Eine globale Graph-Cut-Seamline-Optimierung ist nicht Bestandteil dieser
Entscheidung. Die UX nennt deshalb die tatsächlich implementierte Auswahl nach
Blickgeometrie und nicht „Seamline-optimiert“.
