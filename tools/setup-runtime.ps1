# 准备本机翻译运行时（不修改全局 Python）
# 用法: powershell -ExecutionPolicy Bypass -File tools\setup-runtime.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sentences = "sentencepiece-0.2.3-cp313-cp313-win_amd64.whl"
$ct2 = "ctranslate2-4.9.0-cp313-cp313-win_amd64.whl"
$sentencesUrl = "https://mirrors.aliyun.com/pypi/packages/a3/39/41b3c56beb8ced46bfb346a638ca588741fcd10b6e1143d9143787e1c66d/$sentences"
$ct2Url = "https://mirrors.aliyun.com/pypi/packages/3f/71/cd84a3e26cf8a932c7826a4e7d45ddbf2e2899880d6dcc5ad4833169e6da/$ct2"

New-Item -ItemType Directory -Force .wheels, .tmp\wheels, .runtime | Out-Null
$node = (Get-Command node).Source

foreach ($item in @(
    @{ Url = $sentencesUrl; File = ".wheels/$sentences"; Size = 1655543; Conn = 4 },
    @{ Url = $ct2Url; File = ".wheels/$ct2"; Size = 20408731; Conn = 6 })) {
    if (-not (Test-Path $item.File)) {
        & $node tools\pget.mjs $item.Url $item.File $item.Size $item.Conn
        if ($LASTEXITCODE -ne 0) { throw "下载失败: $($item.File)" }
    }
}

Get-ChildItem .wheels -Filter *.whl | ForEach-Object {
    $zip = ".tmp\wheels\$($_.BaseName).zip"
    Copy-Item $_.FullName $zip -Force
    Expand-Archive -Path $zip -DestinationPath .runtime -Force
    Write-Host "已解包 $($_.Name)"
}

$env:PYTHONPATH = (Join-Path $root '.runtime')
$env:PYTHONIOENCODING = 'utf-8'
python -c "import ctranslate2, sentencepiece; print('ctranslate2', ctranslate2.__version__, '| sentencepiece ok')"
if ($LASTEXITCODE -ne 0) { throw "运行时验证失败：python 无法 import ctranslate2/sentencepiece" }
Write-Host '运行时准备完成。'
