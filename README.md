# LAN Tool + iPerf3 WebUI

Direkt-LAN-Messungen zwischen zwei Rechnern (**PC A / PC B**) mit:

- **IP-Setup Tool**
  - Windows: PowerShell-Menü
  - Linux: Bash-Menü (setzt IP/Firewall und startet in neuem Terminal)
- **iPerf3 Tests über WebUI (Python/Flask)**
  - Live-Stream (SSE), Interface-Stats, Run-Logs

**Autor:** Jumbo125  
**Lizenz:** MIT


- Originalprojekt: MaddyDev-glitch  
- Fork/Weiterentwicklung: Jumbo125
---

## Was hat sich geändert?

### Neu: Ausführbare Windows & Linux Starts inkl. IP-Einstellung
- **IP-Setup jetzt in zwei Varianten:**
  - **Windows:** PowerShell-Menü `Setup_IP/ip_setup.ps1` (Start über `Start_win.bat`)
  - **Linux:** Bash-Menü `Start_Linux.sh` (setzt IP/Firewall/Start in neuem Terminal)

### WebUI ist OS-agnostisch (Windows oder Linux)
- Läuft auf **Windows oder Linux**
- **iPerf3-Binary wird automatisch je nach OS/Architektur gewählt:**
  - **Windows:** `..\IPERF\iperf3.exe` (falls vorhanden), sonst `iperf3` aus `PATH`
  - **Linux:** `..\IPERF\iperf3-amd64` oder `..\IPERF\iperf3-arm64v8` (macht `chmod +x`), sonst `iperf3` aus `PATH`
 
### CRC UND FCS Troubleshooting
- Fehlerindikatoren: Kabelbruch, zu langes Kabel, schlechte Stecker/Knicks
(CRC/FCS & Co.)

### Stabilitäts-Änderungen (PATCH 2026-02-13)
- `/run_iperf` blockiert nicht mehr durch langsame Counter-Reads:
  - Baseline-Counter werden im **Worker-Thread** gelesen (nicht im HTTP-Handler)
- `run_cmd()` hat **Timeouts**, damit PowerShell/`ethtool` nicht ewig hängen

### Pro Run Logfile + Meta-Stream
- Jeder Test schreibt nach: `logs/iperf_YYYYMMDD_HHMMSS.log`
- WebUI streamt zusätzlich Metainfo:
  - `CMD: ...`
  - `LOGFILE: ...`
  - `WORKER: ...`

### iPerf Ausgabe im JSON-Format
- iPerf läuft mit `--json` (leichter parsbar/robuster)

---

## Rollen: PC A / PC B (Wichtig)

| Rolle | Gerät | Aufgabe |
|------|------|---------|
| **PC A** | WebUI-PC | WebUI (Flask GUI) läuft und wird im Browser genutzt |
| **PC B** | Server-PC | iPerf3 **Server** läuft im Terminal/Konsole (**offen lassen**) |

**Hinweis:** Windows/Linux kann beliebig gemischt werden.  
**Wichtig:** **PC B muss der Server sein**, PC A startet den Client über die WebUI.

---

## Voraussetzungen

### Hardware
- 1× LAN-Kabel (direkt PC↔PC oder via Switch)
- Beide PCs im selben Netz (im Tool: `192.168.10.0/24`)

### Software
- iPerf3 ist im Projekt enthalten **oder** im `PATH` verfügbar
- WebUI: Python/Flask App wird über Start-Skripte gestartet (oder manuell)

### Rechte
- **Windows:** `Start_win.bat` verlangt **Admin** (prüft via `net session`)
- **Linux:** `Start_Linux.sh` verlangt **sudo/root** (`id -u == 0`)

---

## Quickstart (Generisch – gilt für alle OS-Kombis)

### PC A (WebUI-PC)
1. Adapter wählen  
2. Backup erstellen  
3. Firewall-Regeln setzen (oder temporär deaktivieren – falls nötig)  
4. PC A IP setzen: `192.168.10.1/24`  
5. PC A starten: startet die WebUI (Flask)  
6. Browser öffnen:
   - `http://192.168.10.1:5000`
   - oder `http://localhost:5000`

### PC B (Server-PC)
1. Adapter wählen  
2. Backup erstellen  
3. Firewall-Regeln setzen (oder temporär deaktivieren)  
4. PC B IP setzen: `192.168.10.2/24`  
5. PC B starten: iPerf3 Server läuft im Terminal → **nicht schließen**

### Nach dem Test (Cleanup)
- Firewall wieder aktivieren (falls deaktiviert)
- Firewall-Regeln entfernen
- Restore (Backup zurück) **oder** DHCP aktivieren

---

## Windows Ablauf (Start über `Start_win.bat`)

### Startscript: `Start_win.bat`
- Macht Admin-Check (ohne UAC prompt)
  - wenn nicht Admin → Fehlermeldung + Hinweis „Als Administrator ausführen“
- Startet danach:
  - `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup_IP\ip_setup.ps1"`

### Windows Quick Guide – PC A
1. `Start_win.bat` **als Administrator** starten  
2. Im PowerShell-Menü:
   - `8)` Adapter wechseln (falls nötig)
   - `1)` Backup schreiben
   - `6)` Firewall-Regel setzen
   - optional `12)` Windows Firewall **DEAKTIVIEREN**
   - `4)` PC A setzen → `192.168.10.1/24`
   - `9)` PC A starten → öffnet neues CMD (WebUI/Starter)
3. Browser öffnen: URL aus dem CMD (typisch `http://192.168.10.1:5000`)

### Windows Quick Guide – PC B
1. `Start_win.bat` **als Administrator** starten  
2. Im PowerShell-Menü:
   - `8)` Adapter wechseln
   - `1)` Backup schreiben
   - `6)` Firewall-Regel setzen
   - optional `12)` Windows Firewall **DEAKTIVIEREN**
   - `5)` PC B setzen → `192.168.10.2/24`
   - `10)` PC B starten → CMD offen lassen (iPerf3 Server)
3. Wenn fertig:
   - `11)` Firewall **AKTIVIEREN**
   - `7)` Firewall-Regel löschen
   - `2)` Wiederherstellen **oder** `3)` DHCP aktivieren

---

## Linux Ablauf (Start über `Start_Linux.sh`)

### Startscript: `Start_Linux.sh`
Das Script übernimmt:
- **Adapter-Auswahl** (Pflicht beim Menüstart)
- **Backup/Restore als JSON** (über „portable python“ oder system `python3`)
- **DHCP / Static IP**
  - bevorzugt via `nmcli`
  - Fallback via `ip`/`dhclient`
- **UFW Regeln**
  - TCP/UDP Port **5201** nur von `192.168.10.1` und `192.168.10.2`
  - ICMP Ping: schreibt einen Block in `/etc/ufw/before.rules`
  - Block-Marker: `# LAN_TOOL_BEGIN` bis `# LAN_TOOL_END`
  - Erstellt einmalig Backup: `/etc/ufw/before.rules.lan_tool.bak`
- Start **PC A/B in neuem Terminal** (wenn möglich):
  - `Setup_IP/Start_PC_A_Linux.sh`
  - `Setup_IP/Start_PC_B_Linux.sh`
  - **Wichtig:** Diese Start-Skripte werden **nicht mehr generiert** – sie müssen **fix existieren**.

---

## WebUI / iPerf3 Hinweise

- PC A startet iPerf-Client über die WebUI, PC B muss iPerf-Server sein.
- Pro Run wird ein Logfile geschrieben: `logs/iperf_YYYYMMDD_HHMMSS.log`
- WebUI streamt zusätzlich `CMD/LOGFILE/WORKER`.
- iPerf läuft mit `--json` für stabile Auswertung.
- Interface-Stats:
  - Windows: `Get-NetAdapterStatistics`
  - Linux: `ethtool -S` (CRC/FCS je nach Treiber)

---

## Releases (wichtig)

In den Releases sind zusätzlich enthalten:
- **iPerf-Binaries**
  - `IPERF/iperf3.exe`
  - `IPERF/iperf3-amd64`
  - `IPERF/iperf3-arm64v8`
- Optional: **Portable Python** für Linux
  - z.B. `PORTABLE_linux_amd/`, `PORTABLE_linux_aarch64/`

Damit ist das Projekt auch ohne „System-Python“ auf Linux schnell nutzbar.

---

## Lizenz

MIT – siehe `LICENSE`.

---

## Credits

- Originalprojekt: MaddyDev-glitch  
- Fork/Weiterentwicklung: Jumbo125
