Ich will ein eigenes CAD bauen.
Ich will von vorneherein so vorgehen, dass schon beim MVP die Architektur der Software so ist, dass später keine Konflikte entstehen, wenn man weitere Features added.

Das CAD soll 3D-Punktwolke first sein, nicht 2D first und nachnach 3D adden.
Es soll opensource sein, aber kommerziell vertrieben. Forken und selber builden nur für privaten Nutzen erlaubt.
Alle opensource libraries die integriert werden müssen das in ihrer Lizens erlauben.
Es soll eine Elektron App werden die auf Pottree aufbaut, dieses aber forked und neu buildet als Grundlage.

Der Name ist Himmelcad. Wir fangen an mit Himmelcad Polyshape, dem eigentlichen CAD. Später wird Himmelcad Photolab hinzukommen, einem Agisoft Metashape Klon mit integriertem Feature für Scan importe, ausgleichungen und georeferenzierung und mit der möglichkeit gaussian splats zu builden und dann soll noch Himmelcad Weltview hinzukommen, einem browserbasierten Viewer für Polyshape Projekte mit eingeschränkter funktion, also nicht bearbeiten, nur viewen und measurements und so, eventuell it der möglichkeit der integration von livedaten von IOT devices für wirkliche digitale zwilinge.
Eventuell noch Himmelcad Chronogit, aber nur nach einer positiven machbarkeitsstudie.
Außerdem noch Himmelcad Testflight. Hier soll man geskriptete Simulationen laufen lassen können, wie Regenfluss, Wind oder man soll mit Fahrzeugen ein DGM einer Straße abfahren können um Schleppkurven zu ermitteln. Dies auch nur nach einer positiven Machbarkeitsstudie.

Im libs ordner befinden sich die libraries auf denen alles aufbaut, oder die inspirationen sind. hier liegt zb pottree, damit man es modifizieren und neu bauen kann. oder hier liegt auch die erste implementierung, von der können zb das icon, die schriftarten und teile der darstellung in der konsole übernommen werden.
Hier liegt auch cloudcompare von der einige algorithmen geportet werden können.
Hier liegt auch vscode dark islands, das soll die main inspiration für die aesthetik der app sein: wie vscode aber im dark islands look.

Aufgebaut sein soll sie wie folgt:
Oben eine ribbon leiste mit den geordneten funktionen. wenn man sie einklappt bleiben die header der ribbons und mutiern zu dropdownmenüs wo man so trotz einklappung alle funktionen auswählen kann.
Linke leiste: Ein Tree mit den Elementen, also Punktwolken, Linien, etc. Später mit Reitern wo man andere sortierungen haben kann, wie zb nach layern.
Rechte Leiste: das Funktionsmenü. Wenn man in der oberen Leiste eien Funktion auswählt öffnet sich diese Seite automatisch mit den Einstellungen zur funktion, also wo ich einzelne Parameter auswählen kann. zb ich öffne die "hintergrundfarbe" funktion, dann erscheint in der rechten leiste ein colorpicker.
Untere leiste: Die Konsole. orientiere dich hier an der v01 implementation. sie soll immer übersichtlich und hübsch sein.
Die Linke, rechte und untere Leiste sollen immer einklappbar sein. die rechte soll sich automatisch expanden wenn ein efunktion ausgewählt wird.
In der Mitte: der eigentliche View. Später auch mit reitern, wo zwischen views wechseln kann.
Im View soll es unten rechts eine koordinatenanzeige des cursers geben. Der curser soll wenn er im view ist immer eine 3d koordinate haben. dies soll immer die vom nächstegelgen punkt der punktwolke sein, bzw ein stützpunkt einer 3d linie, oder der punkt auf einem mesh. oder wenn eine lücke ist, soll es die 3d koordinate aus den nächsten umliegenden punkten interpolieren. hier muss berücksichtigt werden, was die aktuelle orientierung des views ist. die curser koordinate richtig zu haben ist das erste herzstück das stimmen muss.
Wir wollen übrigens immer mit übergeordneten koordinaten arbeiten, also eventuell müssen wir beim import die punktwolke im hintergrund für den nutzer nicht sichtbr verschieben, damit pottree funktioniert.

Zur tatsenbelegung im view:
linke maus klick: auswahl
linke maus hold: orbit (mit z is allways up!!! (eventuell müsste es abhängig von der potree implementierung y is allways up heißen, es soll halt der horizont immer stabil bleiben, du weißt was ich meine))
rechte maus klick: wenn etwas ausgewählt soll es funktionen für das element anzeigen, wenn nicht ausgewählt soll es neber dem curser eine minifunktionsleite öffnen. ich kann hier per rechtsklick auf eine funktion in der oberen leiste funktionen hinzufügen, die ich dann so schnell aufrufen kann.
rechte maus hold: pan
linke maus doppelklick: funktion beenden, also zb eine gezeichnete linie abschließen
späer soll man mit buchstabeneingabe wie im autocad funktionen aufrufen können.
ich will später auch eine python konsole mit der man selber custom skripts schreiben kann.

entities:
wir wollen eventually folgende entity types haben können:
- punktwolken
- einzelpunkte
- alles was dxf/dwg kann. wir wollen voll kompatibel sein mit einem dxf import. eventuell mappen wir aber mehrere dxf entities zu einem himelcad entity
- texturierte meshes. sehr hochauflösende eshes mit mehreren millionen dreiecken, die mit gekachelten bilden texturiert sein können, sodass mein reinzoomen die auflösung imernoch gut ist es aber performant bleibt
- gaussian splats
- achselemente, wie komplette achsen, klotoide, gradiente, böschungen, breitenbänder, etc
- IFC 3d elemente. wir wollen vole import kompatibilität mit ifc dateien
- 3d elemte für kanalbau, wie schächte und haltungen

jedes element soll eine nested attributtabelle haben. hier kann man dann ifc elemt eigenschaften drauf mappen, oder gis kompatibilität mit attributtabellen herstellen oder einzelpunkte einer csv importieren die auch mehrere codes und eigenschaften haben.
Außerdem wollen wir parität mit spezifikationen haben wie in RIB civil, wi etwas also dargestelt wird wenn ich normale cad elemnte zeichne.
Man soll einfache cad elemnte auch wandeln können. Zb eine linie in eine wand wen ich zb spezifiziere die Linie ist Leitlinie unten innen und die wnd hat höhe x.oder einen punkt zu einem schacht wandeln und ihm einen anderen punkt als deckel zuweisen wenn ich noch durchmesser und wandstärke angebe.
Hier müssen wir eine gute balnce finden außs frei wählbaren "reinschreibattributen" und attributen die die 3d geometrie und materialeigenschaften und darstellung affekten.

Der Hauptfokus liegt auf Performance und einfacher bedienbarkeit. Performance ist das allerwichtigste.
Ästehtik ist auch wichtig.

Am Anfang habe ich ja Chrongit als mögliche erweiterung erwähnt. ich spiele mit dem Gedanken CAD git fähig zu machen. dafür bräuchten wir aber eine datenarchitektur die später die extraktion von bedeutsamen diffs ermöglicht, die auch anspechend dargestellt werden können.

Ich will jetzt dass du eine Roadmap schreibt und einen implementierungsplan für einen MVP.
Im MVP soll die grundsätzliche UI stimmen, die maustasten belegung soll funktionieren, man soll las importieren können und eine punktwolke segmentieren.
ich wll dass du dir hier schon richtig gedanken machst und nicht nur das mindeste implementierst. also zb: an soll beim import mehrere las auf einemal auswählen können. beim segementieren soll extracted und remaining übersichtlich im tree angezeigt werden, uws.

außerdem will ich das du ein file schreibst mit den regeln die für das ganze projekt gelten, an die du dich immer erinnerst.

mach am anfang gleich alles richtig. wenn vanilla pottree zb päter keine gaussian splats oder texturierte meshes, oder hochauflösende meshes oder sowas unterstützt (BIM elmente könne wir vllt noch auf die kleinen meshe mappen die pottree unterstützt) und du eine gaussian splat library oder caesium intergiren musst, mach das gleich von anfang an.
entscheide dich auch gleich für eine passende datenstruktur die hochperformant bleibt, die wenn machbar git unterstützt später und die aber zumindest strg z gut unterstützt.
Denke auch daran dass es päter mit dem viewer kompatibel sein soll.

hast du noch irgendwelche fragen?



