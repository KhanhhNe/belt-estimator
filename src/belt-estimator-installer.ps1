#requires -Version 5.1
$ErrorActionPreference = 'Stop'

$taskName = 'AutoAttendanceRecordBeltEstimator'
$taskPath = '\BeltEstimator\'
$taskUri = '\BeltEstimator\AttendanceRecordOnWifiChange'
$marker = 'BELT_ESTIMATOR_ATTENDANCE_V1'
$scriptPath = Join-Path $HOME 'attendance-record.ps1'

$escapedUserUniqueCode = $UserUniqueCode.Replace("'", "''")

# 1) Always overwrite the worker script
$attendanceScript = @'
#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$UserUniqueCode = '$escapedUserUniqueCode'
$TargetSsidOrProfile = 'MSFTCONNECT'
$ApiUrl = 'https://belt-estimator.khanhhne.com/api/record-attendance'

try {
    $wlan = (netsh wlan show interfaces 2>$null) | Out-String
    if ([string]::IsNullOrWhiteSpace($wlan)) { return }

    $state = [regex]::Match($wlan, '(?im)^\s*State\s*:\s*(.+)$').Groups[1].Value.Trim()
    $ssid = [regex]::Match($wlan, '(?im)^\s*SSID\s*:\s*(.+)$').Groups[1].Value.Trim()
    $profile = [regex]::Match($wlan, '(?im)^\s*Profile\s*:\s*(.+)$').Groups[1].Value.Trim()

    if ($state -ne 'connected') { return }
    if (($ssid -ne $TargetSsidOrProfile) -and ($profile -ne $TargetSsidOrProfile)) { return }

    Invoke-RestMethod `
        -Method Post `
        -Uri $ApiUrl `
        -Headers @{ 'User-Unique-Code' = $UserUniqueCode } `
        -TimeoutSec 15 | Out-Null
}
catch {
    # Keep silent to avoid noisy popups on network changes.
}
'@

Set-Content -Path $scriptPath -Value $attendanceScript -Encoding UTF8

# 2) Make sure WLAN operational log is enabled (event trigger source)
& wevtutil sl 'Microsoft-Windows-WLAN-AutoConfig/Operational' /e:true | Out-Null

# 3) Build desired task XML with unique marker/URI
$escapedScriptPath = $scriptPath.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')

$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>$taskUri</URI>
    <Description>$marker | Records BELT attendance when Wi-Fi changes and connected to MSFTCONNECT.</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-WLAN-AutoConfig/Operational"&gt;&lt;Select Path="Microsoft-Windows-WLAN-AutoConfig/Operational"&gt;*[System[(EventID=8001 or EventID=8003 or EventID=10000 or EventID=10001)]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$escapedScriptPath"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

# 4) Remove stale tasks carrying the same marker (cleanup/idempotency)
$allTasks = Get-ScheduledTask | Where-Object {
    $_.Description -like "*$marker*"
}

foreach ($t in $allTasks) {
    if ($t.TaskName -ne $taskName -or $t.TaskPath -ne $taskPath) {
        Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false
    }
}

# 5) Create/update only when the XML differs
$needsUpdate = $true
try {
    $existingXml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
    $existingNorm = ([xml]$existingXml).OuterXml
    $desiredNorm = ([xml]$taskXml).OuterXml
    $needsUpdate = ($existingNorm -ne $desiredNorm)
}
catch {
    $needsUpdate = $true
}

if ($needsUpdate) {
    Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $taskXml -Force | Out-Null
}

Write-Host "Done. Script written to: $scriptPath"
Write-Host "Task ensured at: $taskPath$taskName"
Write-Host "Marker: $marker"
