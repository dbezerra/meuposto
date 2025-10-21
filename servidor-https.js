const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();

// Servir arquivos estáticos
app.use(express.static('dist'));

// Rota para todas as páginas (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Certificados auto-assinados para desenvolvimento
const options = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt')
};

const PORT = 443;
https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor HTTPS rodando em https://192.168.15.3:${PORT}`);
  console.log(`Acesse no celular: https://192.168.15.3:${PORT}/checkin/entrada`);
});
