# 🚀 INSTRUÇÕES PARA TESTAR NO CELULAR

## 📱 URLs Disponíveis:

### ✅ Para Computador:
- **http://localhost:4200** (funciona sempre)
- **http://192.168.15.3:4200** (pode precisar de flags do Chrome)

### 📱 Para Celular/Tablet:
- **http://192.168.15.3:4200** (mesma rede Wi-Fi)

## 🔧 Soluções para Problemas de Câmera:

### 1️⃣ **Solução Mais Simples - Chrome com Flags:**
Execute o arquivo `chrome-flags.bat` que foi criado.
Isso abre o Chrome com configurações especiais para desenvolvimento.

### 2️⃣ **Solução para Celular - HTTPS:**
Se o celular não conseguir acessar a câmera:

1. **Instale ngrok:** `npm install -g ngrok`
2. **Execute:** `ngrok http 4200`
3. **Use a URL HTTPS** que aparecerá (algo como `https://abc123.ngrok.io`)

### 3️⃣ **Solução Manual - Configurações do Chrome:**
Se estiver usando Chrome no computador:

1. Feche todos os Chrome
2. Execute no terminal:
```bash
chrome.exe --unsafely-treat-insecure-origin-as-secure=http://192.168.15.3:4200 --user-data-dir=%TEMP%\chrome_dev_session
```

## 🎯 Teste Imediato:

1. **No computador:** Acesse `http://localhost:4200/checkin/entrada`
2. **No celular:** Acesse `http://192.168.15.3:4200/checkin/entrada`
3. **Se não funcionar:** Use o arquivo `chrome-flags.bat`

## 🔍 Verificar se Está Funcionando:

- ✅ Servidor rodando: `netstat -an | findstr :4200`
- ✅ Acesso externo: Deve mostrar `0.0.0.0:4200`
- ✅ Mesma rede: Celular e computador na mesma Wi-Fi

## 📞 Se Ainda Não Funcionar:

1. Verifique se o firewall não está bloqueando
2. Confirme que estão na mesma rede Wi-Fi
3. Tente reiniciar o roteador
4. Use o ngrok para HTTPS
