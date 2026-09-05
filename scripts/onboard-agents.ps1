[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [Parameter(Position = 0)]
    [string[]] $Providers = @('claude', 'codex', 'opencode')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$providerDestinations = [ordered]@{
    claude   = Join-Path -Path $HOME -ChildPath '.claude\skills\n8n-workflow-safety\SKILL.md'
    codex    = Join-Path -Path $HOME -ChildPath '.agents\skills\n8n-workflow-safety\SKILL.md'
    opencode = Join-Path -Path $HOME -ChildPath '.config\opencode\skills\n8n-workflow-safety\SKILL.md'
}
$failures = New-Object 'System.Collections.Generic.List[string]'

function Add-Failure {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Provider,

        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    $failure = '{0}: {1}' -f $Provider, $Message
    [void] $failures.Add($failure)
    Write-Error -Message ('[onboard] ERROR: {0}' -f $failure) -ErrorAction Continue
}

function Test-ReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-PlainFileHash {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    # Use the .NET reader because Get-FileHash performs provider reads that
    # inherit WhatIfPreference in a -File invocation. Hashing is read-only, so
    # it must still run during a dry-run; only the copy and directory creation
    # use ShouldProcess.
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'Cannot resolve the repository root because $PSScriptRoot is empty.'
    }

    $repoRoot = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '..') -ErrorAction Stop).Path
    $sourceCandidate = Join-Path -Path $repoRoot -ChildPath 'skills\n8n-workflow-safety\SKILL.md'
    $sourceItem = Get-Item -LiteralPath $sourceCandidate -ErrorAction Stop
    if ($sourceItem.PSIsContainer) {
        throw "Canonical skill source is a directory: $sourceCandidate"
    }
    if (Test-ReparsePoint -Path $sourceItem.FullName) {
        throw "Canonical skill source must be a plain file: $sourceCandidate"
    }
    $sourcePath = $sourceItem.FullName
    $sourceHash = Get-PlainFileHash -Path $sourcePath
}
catch {
    Write-Error -Message ('[onboard] ERROR: {0}' -f $_.Exception.Message) -ErrorAction Continue
    exit 1
}

$requestedProviderValues = New-Object 'System.Collections.Generic.List[string]'
foreach ($providerArgument in @($Providers)) {
    if ($null -eq $providerArgument) {
        [void] $requestedProviderValues.Add($null)
        continue
    }

    foreach ($providerValue in ($providerArgument -split ',')) {
        [void] $requestedProviderValues.Add($providerValue)
    }
}

foreach ($requestedProvider in $requestedProviderValues) {
    $providerLabel = if ($null -eq $requestedProvider) { '<empty>' } else { $requestedProvider.Trim() }
    if ([string]::IsNullOrWhiteSpace($providerLabel)) {
        Add-Failure -Provider '<empty>' -Message 'Provider name cannot be empty.'
        continue
    }

    $provider = $providerLabel.ToLowerInvariant()
    if (-not $providerDestinations.Contains($provider)) {
        Add-Failure -Provider $providerLabel -Message "Unknown provider. Supported providers: $($providerDestinations.Keys -join ', ')."
        continue
    }

    $destinationPath = $providerDestinations[$provider]
    $destinationDirectory = Split-Path -Path $destinationPath -Parent

    try {
        $destinationDirectoryExists = Test-Path -LiteralPath $destinationDirectory -PathType Container
        if ($destinationDirectoryExists -and (Test-ReparsePoint -Path $destinationDirectory)) {
            throw "Destination directory must be a plain directory: $destinationDirectory"
        }

        $destinationExists = Test-Path -LiteralPath $destinationPath -PathType Leaf
        if (Test-Path -LiteralPath $destinationPath -PathType Any) {
            $destinationItem = Get-Item -LiteralPath $destinationPath -ErrorAction Stop
            if ($destinationItem.PSIsContainer) {
                throw "Destination path is a directory: $destinationPath"
            }
            if (Test-ReparsePoint -Path $destinationPath) {
                throw "Destination file must be a plain file: $destinationPath"
            }
        }

        $status = 'Installed'
        if ($destinationExists) {
            $destinationHash = Get-PlainFileHash -Path $destinationPath
            if ($destinationHash -eq $sourceHash) {
                $status = 'Already current'
            }
            else {
                $status = 'Updated'
            }
        }

        if ($status -eq 'Already current') {
            Write-Output ('[{0}] {1} | source: {2} | destination: {3}' -f $provider, $status, $sourcePath, $destinationPath)
            continue
        }

        $actionVerb = if ($status -eq 'Installed') { 'install' } else { 'update' }
        $operation = '{0} n8n-workflow-safety skill' -f $actionVerb
        if (-not $PSCmdlet.ShouldProcess($destinationPath, $operation)) {
            Write-Output ('[{0}] Would {1} | source: {2} | destination: {3}' -f $provider, $actionVerb, $sourcePath, $destinationPath)
            continue
        }

        if (-not $destinationDirectoryExists) {
            New-Item -ItemType Directory -Path $destinationDirectory -Force -ErrorAction Stop | Out-Null
        }
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force -ErrorAction Stop

        if (Test-ReparsePoint -Path $destinationPath) {
            throw "Copied destination is not a plain file: $destinationPath"
        }
        $copiedHash = Get-PlainFileHash -Path $destinationPath
        if ($copiedHash -ne $sourceHash) {
            throw 'Copied skill content does not match the canonical source.'
        }

        Write-Output ('[{0}] {1} | source: {2} | destination: {3}' -f $provider, $status, $sourcePath, $destinationPath)
    }
    catch {
        Add-Failure -Provider $provider -Message $_.Exception.Message
    }
}

if ($failures.Count -gt 0) {
    Write-Output ('[onboard] Failed provider count: {0}' -f $failures.Count)
    exit 1
}

exit 0
