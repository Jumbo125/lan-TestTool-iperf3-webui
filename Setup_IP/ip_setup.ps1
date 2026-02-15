# ip_setup.ps1
# Windows 10 / PowerShell 5
# ROBUST VERSION – IPv4 only
# Backup JSON + Restore + DHCP + WMI Fallback + Firewall + Profil-Auswahl
# + Start PC A/B via BAT in neuem cmd-Fenster
# + Adapter wechseln + Pflichtauswahl beim initialen Menüstart

param(
    [ValidateSet("menu","pcA","pcB","backup","restore","dhcp")]
    [string]$Action = "menu",

    [string]$InterfaceAlias = "",

    [switch]$NoRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------
# DEFAULTS
# ---------------------------
$IPERF_PORT      = 5201
$FW_RULE_ICMP    = "LAN_ICMP_Any_192.168.10"
$FW_RULE_IPERF_T = "LAN_iPerf3_TCP_5201_192.168.10"
$FW_RULE_IPERF_U = "LAN_iPerf3_UDP_5201_192.168.10"

$IFACE_DEFAULT = "Ethernet 2"
$IP_PC_A       = "192.168.10.1"
$IP_PC_B       = "192.168.10.2"
$PREFIXLEN     = 24

$FW_RULE_NAME  = "LAN_ICMP_Private_192.168.10"
$FW_IPS        = @($IP_PC_A,$IP_PC_B)

# ---------------------------
# PATHS
# ---------------------------

$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }

$BAT_PC_A = Join-Path $SCRIPT_DIR "Start_PC_A.bat"
$BAT_PC_B = Join-Path $SCRIPT_DIR "Start_PC_B.bat"

# ---------------------------
# ADMIN CHECK
# ---------------------------

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host "Administratorrechte erforderlich!" -ForegroundColor Red
    pause
    exit
}

# ---------------------------
# HELPER
# ---------------------------

function Get-BackupPath([string]$iface) {
    return Join-Path $SCRIPT_DIR "lan_backup_$($iface.Replace(' ','_')).json"
}

function Restart-AdapterSafe([string]$iface) {
    if ($NoRestart) { return }
    try {
        Restart-NetAdapter -Name $iface -Confirm:$false -ErrorAction Stop | Out-Null
        Start-Sleep -Seconds 2
    } catch {}
}

function PrefixToMask([int]$prefix) {
    if ($prefix -lt 0 -or $prefix -gt 32) { throw "Ungültiger Prefix: $prefix" }

    $bits = ("1" * $prefix).PadRight(32,"0")
    $octets = @()
    for ($i=0; $i -lt 4; $i++) {
        $segment = $bits.Substring($i*8,8)
        $octets += [convert]::ToInt32($segment,2)
    }
    return ($octets -join ".")
}

function Get-WmiAdapter([string]$iface) {
    $net = Get-NetAdapter -Name $iface -ErrorAction SilentlyContinue
    if (-not $net) { return $null }

    return Get-WmiObject Win32_NetworkAdapterConfiguration |
           Where-Object { $_.InterfaceIndex -eq $net.ifIndex }
}

function Start-BatInNewWindow([string]$batPath) {
    if (-not (Test-Path -LiteralPath $batPath)) {
        throw "BAT nicht gefunden: $batPath"
    }

    Start-Process -FilePath "cmd.exe" `
        -WorkingDirectory (Split-Path -Parent $batPath) `
        -ArgumentList @("/k", "`"$batPath`"") | Out-Null
}



# ---------------------------
# ADAPTER AUSWAHL
# ---------------------------

function Get-Adapters {
    Get-NetAdapter |
        Where-Object { $_.HardwareInterface } |
        Sort-Object -Property Name
}

function Resolve-Interface([string]$ifaceCandidate) {
    # 1) explizit angegeben?
    if (-not [string]::IsNullOrWhiteSpace($ifaceCandidate)) {
        $a = Get-NetAdapter -Name $ifaceCandidate -ErrorAction SilentlyContinue
        if ($a) { return $a.Name }
    }

    # 2) Default?
    $a = Get-NetAdapter -Name $IFACE_DEFAULT -ErrorAction SilentlyContinue
    if ($a) { return $a.Name }

    # 3) erster Hardware-Adapter
    $first = Get-Adapters | Select-Object -First 1
    if ($first) { return $first.Name }

    throw "Kein geeigneter Netzwerkadapter gefunden."
}

function Select-AdapterInteractive([string]$currentIface, [switch]$ForceChoice) {
    while ($true) {
        Clear-Host
        Write-Host "============================================================"
        Write-Host "  Adapter wählen"
        Write-Host "============================================================"
        Write-Host ""

        $list = @(Get-Adapters)
        if ($list.Count -eq 0) {
            Write-Host "Keine Adapter gefunden (Get-NetAdapter)." -ForegroundColor Yellow
            pause
            return $currentIface
        }

        $names = @($list | ForEach-Object { $_.Name })
        $curIdx0 = [array]::IndexOf($names, $currentIface)
        $defIdx0 = if ($curIdx0 -ge 0) { $curIdx0 } else { [array]::IndexOf($names, $IFACE_DEFAULT) }
        if ($defIdx0 -lt 0) { $defIdx0 = 0 }
        $defNum = $defIdx0 + 1

        for ($i=0; $i -lt $list.Count; $i++) {
            $x = $list[$i]
            $mark = if (($i+1) -eq $defNum) { "*" } else { " " }
            Write-Host (" {0}{1,2}) {2}  [{3}] (IfIndex {4})" -f $mark, ($i+1), $x.Name, $x.Status, $x.ifIndex)
        }

        Write-Host ""
        if ($ForceChoice) {
            $in = (Read-Host ("Nummer wählen (1..{0})" -f $list.Count)).Trim()
        } else {
            $in = (Read-Host ("Nummer wählen (Default: {0})" -f $defNum)).Trim()
            if ([string]::IsNullOrWhiteSpace($in)) { $in = [string]$defNum }
        }

        if ($in -match '^\d+$') {
            $n = [int]$in
            if ($n -ge 1 -and $n -le $list.Count) {
                return $list[$n-1].Name
            }
        }

        Write-Host ""
        Write-Host ("[FEHLER] Ungültige Nummer. Bitte 1..{0}." -f $list.Count) -ForegroundColor Red
        pause
    }
}

# ---------------------------
# BACKUP
# ---------------------------

function Backup-Config([string]$iface) {
    try {
        $ipif = Get-NetIPInterface -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction Stop

        $ips  = Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.PrefixOrigin -eq "Manual" } |
                Select-Object -First 1

        $cfg  = Get-NetIPConfiguration -InterfaceAlias $iface -ErrorAction SilentlyContinue

        $obj = [pscustomobject]@{
            Date      = Get-Date
            Interface = $iface
            DHCP      = ($ipif.Dhcp -eq "Enabled")
            IP        = $ips.IPAddress
            Prefix    = $ips.PrefixLength
            Gateway   = $(if ($cfg -and $cfg.IPv4DefaultGateway) { ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop } else { $null })
            DNS       = $(if ($cfg -and $cfg.DnsServer -and $cfg.DnsServer.ServerAddresses) { $cfg.DnsServer.ServerAddresses } else { @() })
        }

        $path = Get-BackupPath $iface
        $obj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
        Write-Host "[OK] Backup gespeichert: $path" -ForegroundColor Green
    }
    catch {
        Write-Host "[FEHLER] Backup fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ---------------------------
# DHCP
# ---------------------------

function Set-DHCP([string]$iface) {
    try {
        Set-NetIPInterface -InterfaceAlias $iface -AddressFamily IPv4 -Dhcp Enabled -PolicyStore ActiveStore -ErrorAction Stop

        Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.PrefixOrigin -eq "Manual" } |
            Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue

        Set-DnsClientServerAddress -InterfaceAlias $iface -ResetServerAddresses -ErrorAction SilentlyContinue

        Restart-AdapterSafe $iface
        ipconfig /release | Out-Null
        ipconfig /renew   | Out-Null

        Write-Host "[OK] DHCP aktiviert." -ForegroundColor Green
    }
    catch {
        Write-Host "[WARN] NetTCPIP DHCP fehlgeschlagen – WMI Fallback..." -ForegroundColor Yellow

        $wmi = Get-WmiAdapter $iface
        if ($wmi) {
            $wmi.EnableDHCP() | Out-Null
            $wmi.SetDNSServerSearchOrder($null) | Out-Null
            Restart-AdapterSafe $iface
            Write-Host "[OK] DHCP via WMI aktiviert." -ForegroundColor Green
        } else {
            Write-Host "[FEHLER] WMI Adapter nicht gefunden (DHCP)." -ForegroundColor Red
        }
    }
}

# ---------------------------
# STATIC (ohne Gateway)
# ---------------------------

function Set-Static([string]$iface, [string]$ip, [int]$prefix) {
    try {
        Set-NetIPInterface -InterfaceAlias $iface -AddressFamily IPv4 -Dhcp Disabled -PolicyStore ActiveStore -ErrorAction Stop

        Get-NetIPAddress -InterfaceAlias $iface -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.PrefixOrigin -eq "Manual" } |
            Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue

        New-NetIPAddress -InterfaceAlias $iface -IPAddress $ip -PrefixLength $prefix -ErrorAction Stop | Out-Null
        Set-DnsClientServerAddress -InterfaceAlias $iface -ResetServerAddresses -ErrorAction SilentlyContinue

        Restart-AdapterSafe $iface
        Write-Host "[OK] Static IP gesetzt: $ip/$prefix" -ForegroundColor Green
    }
    catch {
        Write-Host "[WARN] NetTCPIP Static fehlgeschlagen – WMI Fallback..." -ForegroundColor Yellow

        $mask = PrefixToMask $prefix
        $wmi  = Get-WmiAdapter $iface

        if ($wmi) {
            $wmi.EnableStatic(@($ip),@($mask)) | Out-Null
            $wmi.SetGateways($null,$null) | Out-Null
            $wmi.SetDNSServerSearchOrder($null) | Out-Null
            Restart-AdapterSafe $iface
            Write-Host "[OK] Static via WMI gesetzt." -ForegroundColor Green
        } else {
            Write-Host "[FEHLER] WMI Adapter nicht gefunden (Static)." -ForegroundColor Red
        }
    }
}

# ---------------------------
# RESTORE
# ---------------------------

function Restore-Config([string]$iface) {
    $path = Get-BackupPath $iface
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Kein Backup gefunden." -ForegroundColor Red
        return
    }

    $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json

    if ($data.DHCP) { Set-DHCP $iface }
    else            { Set-Static $iface $data.IP $data.Prefix }

    Write-Host "[OK] Restore abgeschlossen." -ForegroundColor Green
}

# ---------------------------
# FIREWALL (NUR Private) – FIX: RemoteAddress als Array
# ---------------------------
function Get-InterfaceParam([string]$iface) {
    # Gibt eine Hashtable zurück, die man als @ifaceParam splatten kann.
    # Wenn das Interface nicht existiert => leere Hashtable (keine Bindung)
    $p = @{}

    if (-not [string]::IsNullOrWhiteSpace($iface)) {
        $a = Get-NetAdapter -Name $iface -ErrorAction SilentlyContinue
        if ($a) {
            $p.InterfaceAlias = $a.Name
        } else {
            Write-Warning "InterfaceAlias '$iface' nicht gefunden – Regeln werden OHNE Interface-Bindung erstellt."
        }
    } else {
        Write-Warning "Kein InterfaceAlias übergeben – Regeln werden OHNE Interface-Bindung erstellt."
    }

    return $p
}

function Set-Firewall([string]$iface) {

    $ifaceParam = Get-InterfaceParam $iface

    # IPs säubern + validieren (unterstützt auch CIDR wie 192.168.10.0/24 sowie Any/LocalSubnet)
    $remote = @(
        $FW_IPS |
        ForEach-Object { if ($_) { $_.ToString().Trim() } } |
        Where-Object { $_ -ne "" }
    )
    if ($remote.Count -eq 0) { $remote = @("Any") }

    foreach ($r in $remote) {
        if ($r -in @("Any","LocalSubnet")) { continue }

        if ($r -match '^(?<ip>[^/]+)/(?<p>\d{1,3})$') {
            $ip = $Matches.ip
            $p  = [int]$Matches.p
            if ($p -lt 0 -or $p -gt 128) { throw "Ungültiger Prefix in FW_IPS: '$r'" }
            try { [void][System.Net.IPAddress]::Parse($ip) } catch { throw "Ungültige IP in FW_IPS: '$r'" }
            continue
        }

        try { [void][System.Net.IPAddress]::Parse($r) }
        catch { throw "Ungültige IP in FW_IPS: '$r'" }
    }

    # Alte Regeln weg
    @($FW_RULE_ICMP, ($FW_RULE_ICMP + " v6"), $FW_RULE_IPERF_T, $FW_RULE_IPERF_U) | ForEach-Object {
        Get-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }

    # 1) ICMPv4 Ping (Echo Request = Type 8)
    New-NetFirewallRule `
        -DisplayName $FW_RULE_ICMP `
        -Direction Inbound `
        -Protocol ICMPv4 `
        -IcmpType 8 `
        -RemoteAddress $remote `
        -Action Allow `
        -Profile Any `
        -Enabled True `
        @ifaceParam | Out-Null

    # 1b) ICMPv6 Ping (Echo Request = Type 128) – optional, schadet nicht
    New-NetFirewallRule `
        -DisplayName ($FW_RULE_ICMP + " v6") `
        -Direction Inbound `
        -Protocol ICMPv6 `
        -IcmpType 128 `
        -RemoteAddress $remote `
        -Action Allow `
        -Profile Any `
        -Enabled True `
        @ifaceParam | Out-Null

    # 2) iPerf3 TCP 5201
    New-NetFirewallRule `
        -DisplayName $FW_RULE_IPERF_T `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $IPERF_PORT `
        -RemoteAddress $remote `
        -Action Allow `
        -Profile Any `
        -Enabled True `
        @ifaceParam | Out-Null

    # 3) iPerf3 UDP 5201
    New-NetFirewallRule `
        -DisplayName $FW_RULE_IPERF_U `
        -Direction Inbound `
        -Protocol UDP `
        -LocalPort $IPERF_PORT `
        -RemoteAddress $remote `
        -Action Allow `
        -Profile Any `
        -Enabled True `
        @ifaceParam | Out-Null

    Write-Host "[OK] Firewall-Regeln gesetzt. Interface: '$iface' (falls vorhanden gebunden). Remote: $($remote -join ', '); iPerf3 Port: $IPERF_PORT" -ForegroundColor Green
}

function Remove-Firewall {
    @($FW_RULE_ICMP, ($FW_RULE_ICMP + " v6"), $FW_RULE_IPERF_T, $FW_RULE_IPERF_U) | ForEach-Object {
        Get-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Firewall-Regeln gelöscht." -ForegroundColor Green
}

# ---------------------------
# FIREWALL GLOBAL (Private + Public an/aus)
# ---------------------------

function Enable-FirewallGlobal {
    try {
        Set-NetFirewallProfile -Profile Private,Public -Enabled True -ErrorAction Stop
        $p = Get-NetFirewallProfile -Profile Private,Public
        Write-Host ("[OK] Firewall aktiviert. Private={0} Public={1}" -f $p[0].Enabled, $p[1].Enabled) -ForegroundColor Green
    }
    catch {
        Write-Host "[FEHLER] Firewall aktivieren fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Disable-FirewallGlobal {
    try {
        Set-NetFirewallProfile -Profile Private,Public -Enabled False -ErrorAction Stop
        $p = Get-NetFirewallProfile -Profile Private,Public
        Write-Host ("[OK] Firewall deaktiviert. Private={0} Public={1}" -f $p[0].Enabled, $p[1].Enabled) -ForegroundColor Green
    }
    catch {
        Write-Host "[FEHLER] Firewall deaktivieren fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
    }
}


# ---------------------------
# NON-INTERACTIVE (für BAT)
# ---------------------------

# Für BAT-Aktionen muss der Adapter eindeutig sein
$IFACE = Resolve-Interface $InterfaceAlias

if ($Action -ne "menu") {
    try {
        switch ($Action) {
            "pcA"     { Set-Static  $IFACE $IP_PC_A $PREFIXLEN }
            "pcB"     { Set-Static  $IFACE $IP_PC_B $PREFIXLEN }
            "backup"  { Backup-Config $IFACE }
            "restore" { Restore-Config $IFACE }
            "dhcp"    { Set-DHCP $IFACE }
        }
    } catch {
        Write-Host "[FEHLER] Aktion '$Action' fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 0
}

# ---------------------------
# MENU – beim ersten Start Adapter-Auswahl erzwingen
# ---------------------------

if (-not [string]::IsNullOrWhiteSpace($InterfaceAlias)) {
    # Wenn jemand explizit -InterfaceAlias beim Menüstart angibt
    $IFACE = Resolve-Interface $InterfaceAlias
} else {
    # Pflichtauswahl beim Start
    $IFACE = Select-AdapterInteractive -currentIface (Resolve-Interface "") -ForceChoice
}



while ($true) {

    Clear-Host
    Write-Host "LAN TOOL – ROBUST VERSION"
    Write-Host "Adapter: $IFACE"
    Write-Host ""
    Write-Host "1) Backup schreiben (aktuelle Adapter-Einstellungen werden in eine JSON-Datei gespeichert)"
    Write-Host "2) Wiederherstellen (zuvor gespeicherte Werte werden wiederhergestellt)"
    Write-Host "3) DHCP aktivieren (setzt IPv4 auf DHCP und löscht zuvor manuell gesetzte IPv4-Adressen)"
    Write-Host "4) PC A setzen (deaktiviert DHCP und setzt diesen PC auf IP: x.1)"
    Write-Host "5) PC B setzen (deaktiviert DHCP und setzt diesen PC auf IP: x.2)"
    Write-Host ""
    Write-Host "6) Firewall-Regel setzen (Ping/ICMP für 192.168.10.1 und 192.168.10.2 – ANY)"
    Write-Host "7) Firewall-Regel löschen"
   # Write-Host "8) Netzwerkprofil ändern (empfohlen: Private, sonst greift die Firewall-Regel nicht)"
    #Write-Host ""
    Write-Host "8) Adapter wechseln"
    Write-Host "9) PC A starten -> neues CMD-Fenster (Start_PC_A.bat)"
    Write-Host "10) PC B starten -> neues CMD-Fenster (Start_PC_B.bat)"
    Write-Host ""
	  Write-Host "11) Windows Firewall AKTIVIEREN (Private + Public)"
    Write-Host "12) Windows Firewall DEAKTIVIEREN (Private + Public)"
	Write-Host ""
    Write-Host "0) Exit"
    Write-Host ""

    $c = (Read-Host "Auswahl").Trim()

    switch ($c) {
        "1"  { Backup-Config $IFACE; pause }
        "2"  { Restore-Config $IFACE; pause }
        "3"  { Set-DHCP $IFACE; pause }
        "4"  { Set-Static $IFACE $IP_PC_A $PREFIXLEN; pause }
        "5"  { Set-Static $IFACE $IP_PC_B $PREFIXLEN; pause }
    "6"  { Set-Firewall $IFACE; pause }
"7"  { Remove-Firewall; pause }
       # "8"  { Set-ProfileInteractive $IFACE; pause }

        "8"  {
            $IFACE = Select-AdapterInteractive -currentIface $IFACE
           
            pause
        }

        "9" {
            Start-BatInNewWindow $BAT_PC_A
        }

        "10" {
            Start-BatInNewWindow $BAT_PC_B
        }
		
		  "11" { Enable-FirewallGlobal; pause }
        "12" { Disable-FirewallGlobal; pause }



        "0"  { break }
        default { }
    }
}
