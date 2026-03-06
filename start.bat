@echo off
cd /d "%~dp0"
echo ========================================
echo  OCPP Log Analyzer - Starting...
echo ========================================

if not exist venv (
    echo Creating virtual environment...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate

echo Installing dependencies...
pip install -r requirements.txt -q

echo.
echo Starting server at http://localhost:8000
echo Press Ctrl+C to stop.
echo.
start "" http://localhost:8000
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
