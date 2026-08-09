# ADR 0013: Lizenzsaubere, qualitätsgleiche PhotoLab-Offlineruntimes

## Status

Angenommen

## Kontext

PhotoLab benötigt für die beworbenen Alignment- und Geoprodukte große neuronale Modelle,
DeDoDe-v2-G, GDAL und PROJ. Übliche PyTorch- und NumPy-Binärpakete sowie
Distributionspakete für Geowerkzeuge können OpenMP-, Fortran- oder andere nach der
HimmelCAD-Produktpolicy unzulässige Laufzeiten einbringen. Eine ersatzweise Verkleinerung
des Modells würde zugleich den verbindlichen Qualitätsvertrag verletzen. Windows und Linux
müssen denselben Algorithmus vollständig offline ausführen.

## Entscheidung

- Detector-L-v2, Descriptor-G und DINOv2 ViT-L/14 werden aus den exakt gepinnten
  Originalgewichten als FP32-ONNX-Graphen exportiert. Die Release-Runtime verwendet keine
  kleineren Ersatzmodelle und keine reduzierte Inferenzauflösung.
- Ein versioniertes Manifest inventarisiert jedes Modell- und External-Data-Fragment mit
  Größe und SHA-256. Die Rust-Preflightprüfung verifiziert das vollständige Manifest vor
  jedem Start.
- DeDoDe läuft mit CPython 3.12.13 und ONNX Runtime 1.24.4. NumPy 2.2.6 wird ohne BLAS und
  LAPACK gebaut; die großen Ähnlichkeitsmatrizen berechnet ONNX Runtime MLAS. PyTorch bleibt
  ausschließlich Konvertierungs- und Paritätswerkzeug und wird nicht ausgeliefert.
- Die Windows-NumPy-Erweiterungen werden mit dem gepinnten LLVM-MinGW-UCRT-Toolchain als
  PE-Dateien gebaut. `scripts/build-photolab-windows-numpy.sh` prüft Quellhash, Long-Double-
  ABI und DLL-Imports. Die nativen Rust-Worker verwenden dasselbe UCRT-basierte Ziel.
- Die offiziellen ONNX-Runtime-1.24.4-Windows-Binärdateien benötigen die MSVC-14.4-
  Laufzeit. PhotoLab materialisiert deshalb ausschließlich die vier tatsächlich importierten
  x64-DLLs aus Microsofts Redistributable `14.44.35211.0`. Archiv und Einzeldateien sind
  SHA-256-gepinnt, die Redistributable-Lizenz wird mitgeliefert und die PE-Closure prüft jede
  Abhängigkeit. Die Anwendung installiert nichts systemweit.
- COLMAPs zusätzlicher `libwinpthread-1.dll`-Import stammt aus demselben gepinnten
  LLVM-MinGW-Archiv, ist MIT/BSD-3-Clause-lizenziert und wird mit dem vollständigen
  `COPYING.winpthreads.txt` ausgeliefert.
- GDAL 3.12.4 und PROJ 9.8.1 werden für Linux und Windows aus dem gepinnten vcpkg-Graphen
  statisch gebaut. Release-Staging übernimmt nur die explizit benötigten Werkzeuge,
  Datenbanken und die kuratierten, attribuierten BETA2007-, GCG2016- und SeTa2016-Grids.
- Benutzergewählte Grids werden einmal nach Rolle und sicherem Dateinamen im lokalen PhotoLab-
  Grid-Register kopiert und bei erneuter Wahl direkt wiederverwendet. Die eingefrorene Operation
  bindet Rolle, registrierten Pfad und Datenbankversion; offizielle gebündelte Grids behalten ihre
  Inventar-Prüfsumme, lokale Benutzer-Grids benötigen keine vollständige Hashprüfung. Lokale DHDN-NTv2-Grids
  müssen `SYSTEM_F=DHDN` und `SYSTEM_T=ETRS89` deklarieren und bestehen vor der Auswahl eine
  Vorwärts-/Rückwärtsprobe innerhalb der Bild-AOI. Abweichende Originaldateinamen sind kein
  Fehler, und die Genauigkeit einer offiziellen Operation wird nicht auf ein ersetztes Grid
  übertragen.
- Der Release-Audit hasht alle Dateien und prüft unter Linux die vollständige ELF-Closure,
  unter Windows alle PE-Imports samt Bundling-Closure. `libgomp`, `libgfortran`,
  `libquadmath`, `libiomp`, GPL-, LGPL-, AGPL- und SSPL-Artefakte führen zum Abbruch.
- Schwächere Hardware darf ausschließlich Parallelität, Block- und Chunkgröße reduzieren.
  Modell, Gewichte, Featurebudget, Inferenzdimension und numerischer Modus bleiben gleich.
- Python-Paketmanager, `ensurepip`, Netzkonfiguration und Entwicklungssourcen werden nicht
  in die Anwendung gepackt. Worker starten mit isolierter Umgebung und deaktiviertem Netz.

## Konsequenzen

Die Pakete sind mehrere Gigabyte groß und Builds dauern deutlich länger. Dafür bleibt der
große DeDoDe-Rescuepfad im installierten Produkt verfügbar, Linux und Windows verwenden
denselben Modellvertrag, und die Produktlizenz hängt nicht von der zufälligen Closure eines
Systempakets ab. Jede Runtime- oder Modelländerung erfordert Manifest-, Paritäts-,
Release-Inventar- und Pakettests auf beiden Plattformen.

## Windows-Reproduzierbarkeit

`scripts/build-colmap-worker-win-cross.sh` setzt das Zielsystem explizit auf Windows und
erzeugt den Worker aus COLMAP 4.1.0, dem auditierten Patch, dem gepinnten vcpkg-Commit und
LLVM-MinGW. `scripts/fetch-msvc-runtime.mjs` verifiziert Microsofts Redistributable vor und
nach der Extraktion. Das mit `electron-builder` ausgelieferte `RELEASE_INVENTORY.json`
entsteht ausschließlich nach bestandener vollständiger PE-Closure-Prüfung.

Der am 14. Juli 2026 erzeugte x64-Release bestand die Inventarprüfung mit 2.612
Runtime-Dateien. Setup und Portable enthalten denselben 1.779.091.720-Byte-Payload; beide
NSIS-Container wurden vollständig dekodiert und mit `7za t` geprüft. Der entpackte Payload
umfasst 2.690 Dateien mit 4.057.892.386 Byte. Der enthaltene COLMAP-Worker wurde unter Wine
als Version 4.1.0 ausgeführt, ebenso die isolierte DeDoDe-Python-3.12.13-Runtime. Wine ist
kein Ersatz für den abschließenden Installationstest auf einem echten Windows-Host: Dessen
unvollständige PowerShell-, WMI- und StdUtils-Implementierungen lassen den Silent-Installer
nach erfolgreicher Payload-Prüfung mit Code 2 enden. Die Paket-, PE-Closure- und
Portable-Prüfung ist reproduzierbar; die native Windows-Installationsmatrix bleibt deshalb
ein ausdrücklich getrenntes Release-Gate.

`scripts/check-photolab-packaged-runtime.mjs` verifiziert nach dem Entpacken zusätzlich,
dass jede inventarisierte Runtime-Datei tatsächlich im Electron-Payload liegt und dort noch
dieselbe Größe und SHA-256-Prüfsumme besitzt. Linux- und Windows-Pakete führen dasselbe
`RELEASE_INVENTORY.json` im Ressourcenverzeichnis mit; die Inventarprüfung bindet außerdem
alle DeDoDe-Modelldateien an das im Sidecar gepinnte ONNX-Manifest und weist Python-Bytecode,
`ensurepip` sowie Paketmanager aus dem Staging zurück.

Release-Staging verändert keine gepinnten Dateien unter `vendor/`. Insbesondere wird der
COLMAP-Ordner zuerst nach `.build/photolab-runtime/<platform>/workers/colmap` kopiert; nur diese
plattformbezogene Arbeitskopie erhält benötigte UCRT-/LLVM-MinGW-Laufzeitdateien, wird auditiert
und anschließend paketiert. Damit bleibt ein wiederholter Stage-Lauf reproduzierbar und kann
keinen zuvor geprüften Vendor-Manifestzustand still verändern.

## Package-, Installations- und Start-Gates

Die Gates sind absichtlich getrennt:

| Gate                                                      | Linux                 | Windows cross/Wine                        | Windows nativ       |
| --------------------------------------------------------- | --------------------- | ----------------------------------------- | ------------------- |
| Inventar, Hashes, Lizenz- und Binärclosure                | verpflichtend         | verpflichtend                             | verpflichtend       |
| Entpackter Package-Payload gegen `RELEASE_INVENTORY.json` | verpflichtend         | verpflichtend                             | verpflichtend       |
| Worker-Versionen und DeDoDe-Import                        | nativ                 | optional unter Wine, nicht zertifizierend | verpflichtend nativ |
| Renderer-, Electron- und Sidecar-Start                    | verpflichtend nativ   | nicht durch Wine zertifiziert             | verpflichtend nativ |
| Installer mit anschließendem Start                        | `.deb`/AppImage nativ | nicht durch Wine zertifiziert             | NSIS nativ          |

`scripts/photolab-package-smoke.mjs` prüft einen entpackten Payload. `--mode=static` deckt
Package-Mapping und unveränderte Inventardateien ab; `--mode=native` startet zusätzlich die
kuratierten Worker und die unsichtbare gepackte Anwendung, deren Renderer einen echten
`photolab.hardware.probe`-Roundtrip zum Sidecar bestätigt. `--mode=wine-workers` ist nur ein
Cross-Runtime-Sanity-Check der Windows-Worker und meldet ausdrücklich kein bestandenes
Windows-Installations- oder Start-Gate.

`scripts/photolab-install-smoke.mjs` extrahiert `.deb`/AppImage unter Linux beziehungsweise
installiert NSIS silent auf einem nativen Windows-Host, führt danach denselben nativen
Package-Start-Smoke aus und räumt die temporäre Installation auf. Das Skript verweigert einen
plattformfremden Installationslauf; Wine kann dieses Release-Gate daher nicht versehentlich grün
markieren.
