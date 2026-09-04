$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$git = "C:\Program Files\Git\cmd\git.exe"
$node = "C:\Program Files\nodejs\node.exe"
$logDirectory = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDirectory "weekly-update.log"
$successPath = Join-Path $logDirectory "last-success.json"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

try {
    Set-Location -LiteralPath $projectRoot
    $now = Get-Date
    $daysSinceMonday = (([int]$now.DayOfWeek + 6) % 7)
    $weekStart = $now.Date.AddDays(-$daysSinceMonday).ToString("yyyy-MM-dd")

    if (Test-Path -LiteralPath $successPath) {
        try {
            $lastSuccess = Get-Content -LiteralPath $successPath -Raw | ConvertFrom-Json
            if ($lastSuccess.weekStart -eq $weekStart) {
                Write-Output "This week's update already succeeded at $($lastSuccess.completedAt). Skipping."
                exit 0
            }
        }
        catch {
            Write-Warning "Ignoring an unreadable success marker and retrying the update."
        }
    }

    function Save-SuccessMarker {
        $marker = [ordered]@{
            weekStart = $weekStart
            completedAt = (Get-Date).ToString("o")
        }
        $temporaryPath = "$successPath.tmp"
        $marker | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
        Move-Item -LiteralPath $temporaryPath -Destination $successPath -Force
    }

    if (-not (Test-Path -LiteralPath $git)) { throw "Git을 찾을 수 없습니다: $git" }
    if (-not (Test-Path -LiteralPath $node)) { throw "Node.js를 찾을 수 없습니다: $node" }
    $excel = Get-ChildItem -LiteralPath $projectRoot -File -Filter "DOWN*.xlsx" | Sort-Object Name | Select-Object -First 1
    if ($null -eq $excel) { throw "프로젝트 폴더에서 엑셀 파일을 찾을 수 없습니다." }

    & $git pull --rebase --autostash origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull 실패 (exit $LASTEXITCODE)" }

    & $node (Join-Path $PSScriptRoot "update-site.mjs")
    if ($LASTEXITCODE -ne 0) { throw "사이트 데이터 갱신 실패 (exit $LASTEXITCODE)" }

    & $git add -- $excel.Name "down-sise.html" "index.html" "data/cn-down-prices.json"
    if ($LASTEXITCODE -ne 0) { throw "git add 실패 (exit $LASTEXITCODE)" }

    & $git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Save-SuccessMarker
        Write-Output "No changes found. This week's update is complete."
        exit 0
    }
    if ($LASTEXITCODE -ne 1) { throw "git diff 확인 실패 (exit $LASTEXITCODE)" }

    $today = Get-Date -Format "yyyy-MM-dd"
    & $git commit -m "chore: weekly down price update $today"
    if ($LASTEXITCODE -ne 0) { throw "git commit 실패 (exit $LASTEXITCODE)" }

    & $git pull --rebase origin main
    if ($LASTEXITCODE -ne 0) { throw "게시 전 git pull 실패 (exit $LASTEXITCODE)" }
    & $git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push 실패 (exit $LASTEXITCODE)" }

    Save-SuccessMarker
    Write-Output "Weekly price update and GitHub publish completed."
}
finally {
    Stop-Transcript | Out-Null
}
