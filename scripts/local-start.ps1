$ErrorActionPreference = 'Stop'
$Repo = Split-Path $PSScriptRoot -Parent
$State = 'E:\Media\VLO\.state'
$Scratch = 'E:\Media\VLO\Temp\runtime'
foreach ($folder in @($State,$Scratch,'E:\Media\VLO\Project','E:\Media\VLO\Temp')) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
$env:VLO_LOCAL_MACHINE='1'
$env:VLO_MACHINE_URL='http://127.0.0.1:5679/api/v1/machine'
$env:VLO_RUNTIME_ROOT=$State
$env:VLO_PROJECTS_ROOT='E:\Media\VLO\Project'
$env:VLO_TEMP_ROOT='E:\Media\VLO\Temp'
$env:COMFYUI_URL='http://127.0.0.1:8188'
$env:COMFYUI_INSTALL_DIR='D:\ComfyUI'
$env:SAM2_CACHE_DIR='E:\Media\VLO\Temp\sam2'
$env:SAM_AUDIO_CACHE_DIR='E:\Media\VLO\Temp\sam-audio'
$env:SAM_AUDIO_MODEL_DIR='D:\ComfyUI\models\sam_audio'
$env:BEATTHIS_CACHE_DIR='E:\Media\VLO\Temp\beat'
$env:HF_HOME='E:\model-reserve\huggingface'
$env:TORCH_HOME='E:\model-reserve\rubyapp\torch'
$env:TEMP=$Scratch; $env:TMP=$Scratch
Set-Location (Join-Path $Repo 'backend')
& '.\.venv\Scripts\python.exe' -m uvicorn main:app --host 127.0.0.1 --port 6332
exit $LASTEXITCODE
