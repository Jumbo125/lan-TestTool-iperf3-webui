# LAN Tool + iPerf3 WebUI

Direkt-LAN-Messungen zwischen zwei Rechnern (PC A / PC B) mit:
- IP-Setup Tool (Windows PowerShell **oder** Linux Bash)
- iPerf3 Tests über eine WebUI (Flask) inkl. Live-Stream und Interface-Stats

**Autor:** Jumbo125  
**Lizenz:** MIT

---

## Features

- **Windows IP-Setup** via `Setup_IP/ip_setup.ps1` (Start über `Start_win.bat`)
- **Linux IP-Setup** via `Start_Linux.sh`
  - Adapter-Auswahl, Backup/Restore, DHCP, Static IP
  - UFW Regeln für iPerf (TCP/UDP 5201) + ICMP Ping (before.rules Block)
- **WebUI (Flask)** für iPerf3:
  - Start/Stop eines Runs, Live-Ausgabe via SSE (`/stream_iperf`)
  - Pro Run Logfile unter `logs/`
  - Interface-Info + Error/Drop Counter:
    - Windows: `Get-NetAdapterStatistics`
    - Linux: `ethtool -S` (inkl. CRC/FCS je nach Treiber)

---

## Releases (wichtig)

In den Releases sind zusätzlich enthalten:
- **iPerf-Binaries** (z.B. `IPERF/iperf3.exe`, `IPERF/iperf3-amd64`, `IPERF/iperf3-arm64v8`)
- **Portable Python Verzeichnisse** für Linux (z.B. `PORTABLE_linux_amd/`, `PORTABLE_linux_aarch64/`)

Damit ist das Projekt auch ohne „System-Python“ auf Linux schnell nutzbar.

---

## Quickstart (Kurz)

1) IP-Setup auf beiden PCs ausführen (Backup → Firewall-Regeln → Static IP setzen)  
2) PC B: iPerf3 Server starten (Fenster offen lassen)  
3) PC A: WebUI starten → Browser auf `http://192.168.10.1:5000`

Details siehe Handbuch.

---

## Lizenz

MIT – siehe `LICENSE`.

---

## Credits

- Originalprojekt: MaddyDev-glitch  
- Fork/Weiterentwicklung: Jumbo125
