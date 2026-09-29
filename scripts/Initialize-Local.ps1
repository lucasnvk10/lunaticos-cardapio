$ErrorActionPreference = 'Stop'

function New-Base64UrlSecret([int]$byteCount) {
    $bytes = New-Object byte[] $byteCount
    $randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomNumberGenerator.GetBytes($bytes)
    }
    finally {
        $randomNumberGenerator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$projectPath = Split-Path -Parent $PSScriptRoot
$devVarsPath = Join-Path $projectPath '.dev.vars'

if (-not (Test-Path -LiteralPath $devVarsPath)) {
    $encryptionKey = New-Base64UrlSecret 32
    $devVariables = @("TOKEN_ENCRYPTION_KEY=$encryptionKey")
    [System.IO.File]::WriteAllLines($devVarsPath, $devVariables, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Arquivo .dev.vars criado para proteger os tokens das fichas." -ForegroundColor Green
}

Push-Location $projectPath
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install falhou.' }
    npm run db:migrate:local
    if ($LASTEXITCODE -ne 0) { throw 'A migration local falhou.' }
    npm run db:seed:local
    if ($LASTEXITCODE -ne 0) { throw 'A carga inicial do banco falhou.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'O build falhou.' }
    Write-Host "Ambiente pronto. Execute: npm run dev:full" -ForegroundColor Green
}
finally {
    Pop-Location
}
