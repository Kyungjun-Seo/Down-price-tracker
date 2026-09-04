$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$git = "C:\Program Files\Git\cmd\git.exe"
$node = "C:\Program Files\nodejs\node.exe"
$logDirectory = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDirectory "weekly-update.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

try {
    Set-Location -LiteralPath $projectRoot
    if (-not (Test-Path -LiteralPath $git)) { throw "Git을 찾을 수 없습니다: $git" }
    if (-not (Test-Path -LiteralPath $node)) { throw "Node.js를 찾을 수 없습니다: $node" }

    & $git pull --rebase --autostash origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull 실패 (exit $LASTEXITCODE)" }

    & $node (Join-Path $PSScriptRoot "update-site.mjs")
    if ($LASTEXITCODE -ne 0) { throw "사이트 데이터 갱신 실패 (exit $LASTEXITCODE)" }

    & $git add -- "DOWN 가격동향 계속~ - 복사본.xlsx" "down-sise.html" "index.html" "data/cn-down-prices.json"
    if ($LASTEXITCODE -ne 0) { throw "git add 실패 (exit $LASTEXITCODE)" }

    & $git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Output "변경 사항이 없어 게시를 생략합니다."
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

    Write-Output "주간 다운 시세 갱신 및 GitHub 게시를 완료했습니다."
}
finally {
    Stop-Transcript | Out-Null
}
