# Volumora — Training & Fortschritt

Offline-fähige, installierbare Fitness-PWA für frei konfigurierbare Trainingspläne. Zum Nutzen braucht man ein Konto auf einem Sync-Server (`sync-server/`), der die Daten sichert und den KI-Assistenten bereitstellt. Eine Vorschau mit Beispieldaten ohne Konto und ohne Server gibt es unter `demo.html`.

Die visuellen Regeln sind in [`DESIGN.md`](DESIGN.md) dokumentiert, im neunteiligen DESIGN.md-Format, damit auch KI-Werkzeuge konsistent daran weiterbauen.

## Funktionen
- Deutsch und Englisch: folgt der Gerätesprache, in den Einstellungen umschaltbar; weitere Sprachen sind eine Datei in `src/locales/`
- Beliebig viele Trainingspläne und Tage mit 100 häufigen Übungen erstellen
- Dreistufiger Plan-Assistent für 2–6 Trainingstage mit Vorschau vor dem Speichern
- Flexible Reihenfolge: der nächste Trainingstag folgt auf den zuletzt absolvierten
- Favoriten, zuletzt verwendete Übungen und direkter Übungstausch
- Übungsanimationen und Hinweise werden bei der Auswahl automatisch übernommen
- Durchgehender Trainingsmodus: alle Übungen kompakt untereinander und ohne Weiter-Button
- Abgebrochene Trainings lassen sich von der Startseite aus fortsetzen, auch nach Änderungen am Plan
- Pro Übung nur die Satz-Tabelle, ein „+ Satz“ und ein „⋯“-Menü für Aufwärmsätze, Scheibenrechner, Notiz und RIR
- Arbeits- und Aufwärmsätze, Gewicht, Wiederholungen und Notizen; RIR ist optional und standardmäßig ausgeblendet
- Sätze lassen sich mobil durch Wischen nach links löschen
- Automatisch berechnete Aufwärmsätze
- Automatische Progressive-Overload-Empfehlungen und optionaler Pausentimer
- Trainingsvolumen, geschätztes 1RM und Körpergewicht als Diagramme mit Tooltip, Zeitraumwahl und Volumen pro Muskelgruppe
- Abgeschlossene Trainings lassen sich öffnen, korrigieren und löschen; Bestwerte werden beim Abhaken erkannt
- Übungs-Historie direkt im Training; Pausentimer überlebt einen Neustart und kann im Hintergrund benachrichtigen
- Homescreen-Shortcut „Training starten“
- Gewichtseinheit kg oder lbs (intern immer Kilogramm), Scheibenrechner für Langhantelübungen
- Wochenziel mit Serie auf der Startseite
- Körpermaße und komprimierte Fortschrittsfotos (Fotos liegen in IndexedDB, Messwerte in `localStorage`)
- JSON-Backup, validierter JSON-Import und CSV-Export; Import der CSV-Exporte von Hevy und Strong (Übungen werden dem Katalog zugeordnet, unbekannte werden eigene Übungen)
- Dark Mode, Favoriten sowie Deload-, Krankheits- und Schmerzmarker
- Wochenübersicht und Monatskalender mit Monatsnavigation für geplante und abgeschlossene Einheiten
- Professionelle Übungsanimationen aus einem kuratierten Übungsdatensatz
- Speicherung im Browser (`localStorage`, Fotos in IndexedDB) und automatische Sicherung im Konto auf dem Sync-Server
- PWA-Manifest + Service Worker für Offline-Nutzung
- iPhone-freundliche Safe-Area und Homescreen-Nutzung

## Aufbau
Kein Build-Schritt, kein Framework: `index.html` lädt `src/app.js` als ES-Modul.

| Modul | Aufgabe |
| --- | --- |
| `src/storage.js` | `localStorage`-Zugriff, IndexedDB für Fotos, versionierte Migrationen |
| `src/i18n.js`, `src/locales/*.js` | Übersetzungen: `t(key, params)`, Plural, Datums- und Zahlenformat je Sprache |
| `src/library.js` | Übungskatalog (296 Übungen aus `assets/data/exercises.js`, erzeugt von `tools/import-exercises.mjs`) mit stabilen Schlüsseln für Muskelgruppe, Gerät und Zielmuskel, plus der eingebaute Standardplan; Namen kommen aus dem Wörterbuch, Anleitungen aus `assets/data/steps.*.js` |
| `src/plans.js` | Wochenrhythmus, Plan-Assistent, nächste Einheit |
| `src/workout.js` | Sessions anlegen, fortsetzen, abschließen, Progressionsvorschläge |
| `src/backup.js` | JSON-Export, Validierung und Import, CSV |
| `src/sync.js` | Anmeldung, Registrierung und automatisches Hoch- und Herunterladen der Daten beim Sync-Server |
| `src/aiAccess.js`, `src/ai.js` | Woher der Assistent Claude bekommt (Server oder eigener Schlüssel) und der Claude-Client |
| `src/push.js` | Erinnerung zum Pausenende als Web-Push über den Sync-Server |
| `src/importers.js` | Hevy- und Strong-CSV: Parser, Übungszuordnung, Zusammenführen in den Verlauf |
| `src/charts.js` | Canvas-Diagramme |
| `src/ui.js` | Toast mit Rückgängig, Bottom-Sheets für Bestätigungen und Inhalte (ersetzt `alert`/`confirm`) |
| `src/units.js`, `src/plates.js` | Einheitenumrechnung und Scheibenrechner |
| `src/render.js` | Rendert die aktive View und bindet ihre Events |
| `src/views/*.js` | Eine Datei pro Bildschirm, jeweils `view()` und `bind()` |
| `sync-server/` | Der Sync-Server: Konten, Sicherungen, Claude-Weiterleitung, Push, siehe [`sync-server/README.md`](sync-server/README.md) |

Übungen werden über ihre Bibliotheks-ID (`libraryId`) verknüpft. Verlauf und Kraftkurven bleiben deshalb auch nach Umbenennungen oder Planwechseln zusammen. Trainings und Messungen tragen zusätzlich einen lokalen Tagesschlüssel (`day`, `YYYY-MM-DD`), damit Kalender und Wochenansicht in jeder Zeitzone stabil sind. Das Datenschema ist versioniert; Migrationen in `src/storage.js` laufen genau einmal.

## Lokal starten
Ein Service Worker funktioniert nur über HTTP/HTTPS, nicht direkt per `file://`.

```bash
npm start
```

Dann `http://localhost:8080` öffnen. Alternativ funktioniert jeder statische Server, z. B. `python3 -m http.server 8080`.

Ohne Anmeldung zeigt die App nur den Anmeldebildschirm. Für die Entwicklung einen eigenen Sync-Server starten, einen Einladungscode erzeugen und in der App unter „Anderen Server verwenden“ `http://localhost:8787` eintragen:

```bash
DATA_DIR=/tmp/volumora-sync ALLOWED_ORIGINS=http://localhost:8080 node sync-server/server.js
DATA_DIR=/tmp/volumora-sync node sync-server/admin.js invite
```

## Tests und Formatierung
Unit-Tests decken die reinen Module ab (`tests/unit.test.mjs`). Die Smoke-Tests starten die echte App in Chromium und prüfen die wichtigsten Abläufe: Training, Plan-Editor, Assistent, Fotos, Backup-Import, Datenmigration, Rückgängig-Funktion, Offline-Start und einen axe-core-Check auf Barrierefreiheit. GitHub Actions führt beides bei jedem Push aus.

```bash
npm install
npx playwright install chromium
npm test
npm run format
```

## Konto, Server und Daten
Ein Konto ist Pflicht: Benutzername, Passwort und ein Einladungscode von der Person, die den Server betreibt. Vorgegeben ist der Server des Betreibers von Volumora (`DEFAULT_SYNC_URL` in `src/sync.js`); unter „Anderen Server verwenden“ lässt sich eine andere Adresse eintragen.

Die Daten liegen im Browser des Geräts und, als Sicherung, unter dem Konto auf dem Server: Pläne, Trainings, Körperdaten samt Fortschrittsfotos, Einstellungen, Favoriten, eigene Übungen, der Chat mit dem Assistenten und sein Gedächtnis. Die App lädt Änderungen von selbst hoch; der Server hebt auch ältere Stände auf. Wer den Server betreibt, kann all das lesen. Passwörter speichert der Server nur als Hash (scrypt).

Der KI-Assistent (`src/ai.js`, `src/aiAccess.js`, `src/aiPrompts.js`, `src/aiTools.js`, `src/views/ai.js`) ist Claude von Anthropic. Beim Senden gehen Nachricht, bisheriger Chat, Gedächtnis und eine Trainingszusammenfassung an den Server und von dort an Anthropic, bezahlt mit dem Claude-Schlüssel des Server-Betreibers, für jedes Konto bis zu einem Monatsbudget. Bietet der Server keinen Assistenten an, kann man einen eigenen Claude-API-Schlüssel eintragen; dann geht die Anfrage direkt aus dem Browser an Anthropic, und der Schlüssel bleibt im `localStorage` dieses Geräts, weder im Backup noch auf dem Server. Über Werkzeuge kann der Assistent weitere Trainingsdaten nachschlagen, im Web suchen sowie Pläne, Einstellungen, das laufende Training und Einträge ändern; jede Änderung lässt sich im Chat rückgängig machen, das Löschen eines Plans muss bestätigt werden.

Die Erinnerung zum Pausenende kommt als Push-Nachricht vom Server, der dafür die Push-Anmeldung des Browsers aufbewahrt. Übungsanimationen lädt die App von raw.githubusercontent.com und static.exercisedb.dev. Sätze lassen sich einsprechen (`src/speech.js`, `src/views/dictate.js`): Die Spracherkennung übernimmt das Gerät, das Auswerten läuft lokal.

„Alle Daten löschen“ in den Einstellungen entfernt alles von diesem Gerät und meldet ab; die Sicherung im Konto bleibt. Ein Konto löschen kann die App nicht, das macht die Person, die den Server betreibt (`admin.js delete-user`). Zusätzlich gibt es den JSON-Export als Datei; er enthält auch die Fotos aus IndexedDB, aber weder Chat noch Schlüssel. Beim Import werden alle Werte geprüft und auf das erwartete Format gebracht.

## Betrieb
Die App ist statisch: GitHub Pages veröffentlicht den Stand von `main`, ohne Build-Schritt. Der Sync-Server läuft getrennt davon als Docker-Container beim Betreiber und nimmt nur Anfragen von den Adressen in `ALLOWED_ORIGINS` an; Einrichtung und Verwaltung stehen in [`sync-server/README.md`](sync-server/README.md).

## Lizenz
Der Quellcode steht unter der [MIT-Lizenz](LICENSE). Übungsanimationen und andere Medien von Dritten sind davon ausgenommen und gehören ihren jeweiligen Rechteinhabern, siehe [`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md).
