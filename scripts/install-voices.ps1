<#
    Installs the Marathi and Hindi text-to-speech voices used by the
    "Ask a Question" page, so spoken answers play in the farmer's own
    language instead of falling back to English.

    Install-Language alone is not enough: on Home editions it often registers
    the language with LanguageFeatures "None", meaning no speech synthesis.
    The voice itself ships as a separate optional capability
    (Language.TextToSpeech~~~<lang>~0.0.1.0), which this script adds explicitly.

    Requires administrator rights: voice packs are machine-wide.

        powershell -ExecutionPolicy Bypass -File scripts\install-voices.ps1
#>

$ErrorActionPreference = 'Stop'
$Languages = @('mr-IN', 'hi-IN')

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "Administrator rights are required. Re-launching..." -ForegroundColor Yellow
    try {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
            '-ExecutionPolicy','Bypass','-NoExit','-File',"`"$PSCommandPath`""
        )
    } catch {
        Write-Host "Elevation was declined. Install manually:" -ForegroundColor Red
        Write-Host "  Settings > Time & language > Language & region > Add a language"
        Write-Host "  Choose Marathi, then tick 'Speech' under optional language features."
    }
    return
}

function Show-Voices($heading) {
    Write-Host "`n$heading" -ForegroundColor Cyan
    try {
        [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime] | Out-Null
        foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
            Write-Host ("   {0,-8} {1}" -f $v.Language, $v.DisplayName)
        }
    } catch {
        Write-Host "   (could not enumerate voices: $($_.Exception.Message))"
    }
}

Show-Voices "Voices before:"

# 1. Base language. Harmless if already present.
foreach ($lang in $Languages) {
    Write-Host "`nInstalling base language $lang..." -ForegroundColor Cyan
    try {
        Install-Language -Language $lang -ErrorAction Stop | Out-Null
        Write-Host "   $lang base installed." -ForegroundColor Green
    } catch {
        Write-Host "   $lang base: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# 2. The actual voice. This is the part Install-Language can silently skip,
#    leaving the language present but with no speech synthesis attached.
Write-Host "`nAdding text-to-speech capabilities..." -ForegroundColor Cyan
$added = $false
foreach ($lang in $Languages) {
    $caps = @(Get-WindowsCapability -Online |
              Where-Object { $_.Name -like "Language.TextToSpeech~~~$lang~*" })

    if (-not $caps) {
        Write-Host "   No TextToSpeech package offered for $lang on this build." -ForegroundColor DarkYellow
        continue
    }

    foreach ($cap in $caps) {
        if ($cap.State -eq 'Installed') {
            Write-Host "   $($cap.Name) already installed." -ForegroundColor Green
            $added = $true
            continue
        }
        Write-Host "   Installing $($cap.Name) ..."
        try {
            Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null
            Write-Host "   done." -ForegroundColor Green
            $added = $true
        } catch {
            Write-Host "   failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Show-Voices "Voices after:"

# Report against the speech API rather than assuming the install worked.
$found = @()
try {
    $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
    foreach ($lang in $Languages) {
        $short = $lang.Split('-')[0]
        if (@($all | Where-Object { $_.Language -like "$short*" }).Count) { $found += $lang }
    }
} catch { }

Write-Host ""
if ($found.Count -eq $Languages.Count) {
    Write-Host "All voices are available. Restart your browser completely, then reload the page." -ForegroundColor Green
} elseif ($found.Count) {
    Write-Host ("Available: {0}. Missing: {1}." -f ($found -join ', '), (($Languages | Where-Object { $_ -notin $found }) -join ', ')) -ForegroundColor Yellow
    Write-Host "A Windows restart usually completes registration."
} else {
    Write-Host "No new voices are visible yet." -ForegroundColor Yellow
    Write-Host "Restart Windows, then re-run this script. If they still do not appear, add"
    Write-Host "Marathi via Settings > Time & language > Language & region > Add a language,"
    Write-Host "and make sure 'Speech' is ticked under its optional language features."
}
