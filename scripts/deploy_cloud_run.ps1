# One-shot Cloud Run deploy using the existing GCS service account.
#
# Reads GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY + GCS_BUCKET + CRON_SECRET
# from .env.local at the repo root. Activates the service account
# with gcloud, enables the APIs, runs the deploy, prints the resulting
# service URL.
#
# Requires:
#   - Google Cloud SDK installed (winget install Google.CloudSDK)
#   - The service account has roles/run.admin +
#     roles/cloudbuild.builds.builder + roles/iam.serviceAccountUser on
#     the project. If not, the deploy fails with a clear gcloud error
#     and you grant the missing role in the IAM console.
#
# Idempotent: re-running just updates the existing service.

# Continue (not Stop) because gcloud writes its success messages to
# stderr (e.g. "Activated service account credentials for ..."), and
# PowerShell 5.1 wraps any native-command stderr as a NativeCommandError
# under Stop, aborting the script before the deploy even runs. Every
# native call below has an explicit `if ($LASTEXITCODE -ne 0)` check so
# real failures still surface.
$ErrorActionPreference = "Continue"

# 1. Locate gcloud (winget installs to either ProgramData or LocalAppData).
$gcloudCandidates = @(
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "$env:ProgramData\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
)
$gcloud = $gcloudCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $gcloud) {
    Write-Error "gcloud not found at any expected install path. Run: winget install Google.CloudSDK"
    exit 1
}
Write-Host "[deploy] gcloud at: $gcloud"

# 2. Load env vars from .env.local. We use Python's dotenv because it
#    handles multi-line PEM values correctly (which a simple
#    ConvertFrom-StringData would mangle on the \n boundaries).
$envScript = @"
from dotenv import load_dotenv
load_dotenv('.env.local')
import os, sys
for k in ['GCS_CLIENT_EMAIL', 'GCS_PRIVATE_KEY', 'GCS_BUCKET', 'CRON_SECRET']:
    v = os.environ.get(k, '')
    if not v:
        sys.stderr.write(f'{k} is missing from .env.local\n')
        sys.exit(1)
    # Print on a single line with a sentinel to keep PowerShell parsing simple.
    # We base64-encode private key to avoid newline issues.
    if k == 'GCS_PRIVATE_KEY':
        import base64
        print(f'{k}_B64={base64.b64encode(v.encode()).decode()}')
    else:
        print(f'{k}={v}')
"@
$envLines = python -c $envScript
if ($LASTEXITCODE -ne 0) { exit 1 }
$envVars = @{}
foreach ($line in $envLines) {
    $idx = $line.IndexOf('=')
    if ($idx -lt 0) { continue }
    $envVars[$line.Substring(0, $idx)] = $line.Substring($idx + 1)
}

# 3. Decode the private key + write the SA JSON to a temp file.
$saEmail = $envVars['GCS_CLIENT_EMAIL']
$project = ($saEmail -split '@')[1] -replace '\.iam\.gserviceaccount\.com$', ''
$bucket = $envVars['GCS_BUCKET']
$cronSecret = $envVars['CRON_SECRET']
$rawKey = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($envVars['GCS_PRIVATE_KEY_B64'])
)
# .env stores literal \n escapes; convert to real newlines for the JSON.
$privateKey = $rawKey -replace '\\n', "`n"

$saTemp = [System.IO.Path]::GetTempFileName()
$saTemp = $saTemp + '.json'
$saJson = @{
    type = 'service_account'
    project_id = $project
    private_key = $privateKey
    client_email = $saEmail
    token_uri = 'https://oauth2.googleapis.com/token'
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($saTemp, $saJson)
Write-Host "[deploy] SA JSON written to: $saTemp"

# 4. Activate the service account + set project.
& $gcloud auth activate-service-account --key-file="$saTemp"
if ($LASTEXITCODE -ne 0) { exit 1 }
& $gcloud config set project $project
if ($LASTEXITCODE -ne 0) { exit 1 }

# 5. Enable required APIs (idempotent).
Write-Host "[deploy] Enabling APIs (idempotent, ~30s)..."
& $gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
if ($LASTEXITCODE -ne 0) { exit 1 }

# 6. Deploy. --source builds the image in Cloud Build + ships it.
$region = if ($env:CLOUD_RUN_REGION) { $env:CLOUD_RUN_REGION } else { 'us-central1' }
Write-Host "[deploy] Deploying to Cloud Run (region: $region)..."
Push-Location video
try {
    & $gcloud run deploy lorewire-render `
        --source . `
        --region $region `
        --memory 4Gi `
        --cpu 2 `
        --timeout 3600 `
        --no-allow-unauthenticated `
        --update-env-vars CRON_SECRET=$cronSecret `
        --update-env-vars GCS_BUCKET=$bucket `
        --update-env-vars GCS_CLIENT_EMAIL=$saEmail `
        --update-env-vars "GCS_PRIVATE_KEY=$privateKey"
    if ($LASTEXITCODE -ne 0) { throw "deploy failed" }
} finally {
    Pop-Location
}

# 7. Print the service URL (paste this into Vercel as CLOUD_RUN_RENDER_URL).
$url = & $gcloud run services describe lorewire-render --region $region --format "value(status.url)"
Write-Host ""
Write-Host "================================================================"
Write-Host "DEPLOYED. Set this in Vercel env vars:"
Write-Host "  CLOUD_RUN_RENDER_URL=$url"
Write-Host "================================================================"

# 8. Smoke test.
Write-Host "[deploy] Smoke testing /healthz..."
$healthz = Invoke-WebRequest -Uri "$url/healthz" -UseBasicParsing
if ($healthz.StatusCode -eq 200 -and $healthz.Content -match '"ok":true') {
    Write-Host "[deploy] healthz OK"
} else {
    Write-Warning "[deploy] healthz UNEXPECTED: $($healthz.StatusCode) $($healthz.Content)"
}

# 9. Cleanup the temp SA key.
Remove-Item $saTemp -Force -ErrorAction SilentlyContinue
Write-Host "[deploy] Done."
