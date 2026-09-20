Get-Content "$PSScriptRoot\.env" | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $idx = $_.IndexOf('=')
    if ($idx -lt 1) { return }
    $key = $_.Substring(0, $idx).Trim()
    $value = $_.Substring($idx + 1)
    [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
}

& "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000
