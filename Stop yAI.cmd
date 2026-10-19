@echo off
rem Double-click to take yAI offline and free the GPU (for gaming, etc.).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
pause
