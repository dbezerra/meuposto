@echo off
echo ========================================
echo    SOLUCAO PARA CAMERA NO CELULAR
echo ========================================
echo.
echo Fechando todas as instâncias do Chrome...
taskkill /F /IM chrome.exe > nul 2>&1
timeout /t 2 /nobreak > nul

echo.
echo Iniciando Chrome com flags especiais...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --unsafely-treat-insecure-origin-as-secure=http://192.168.15.3:4200 --user-data-dir=%TEMP%\chrome_dev_session --disable-web-security --allow-running-insecure-content

echo.
echo ========================================
echo    CHROME INICIADO COM SUCESSO!
echo ========================================
echo.
echo URLs para testar:
echo.
echo 💻 COMPUTADOR:
echo    http://localhost:4200/checkin/entrada
echo.
echo 📱 CELULAR/TABLET:
echo    http://192.168.15.3:4200/checkin/entrada
echo.
echo ========================================
echo.
echo IMPORTANTE:
echo - Esta configuracao e apenas para desenvolvimento
echo - A câmera deve funcionar no celular agora
echo - Se nao funcionar, clique em "Soluções HTTPS" na tela
echo.
pause
