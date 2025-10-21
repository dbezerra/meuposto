import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FaceSdkService } from '../../face-sdk.service';
import { TimesService } from '../../core/times.service';
import { Subscription } from 'rxjs';

@Component({
  standalone: true,
  selector: 'app-checkin',
  imports: [CommonModule, RouterModule],
  templateUrl: './checkin.component.html',
  styleUrls: ['./checkin.component.css']
})
export class CheckinComponent implements AfterViewInit, OnDestroy {
  @ViewChild('videoEl', { static: true }) videoEl!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasEl', { static: true }) canvasEl!: ElementRef<HTMLCanvasElement>;

  tipo: 'entrada'|'pausa'|'retorno'|'saida' = 'entrada';
  statusMsg = 'Aproxime-se e olhe para a câmera';
  ok = false;
  cameraPermissionGranted = false;
  showPermissionButton = false;
  showDiagnostics = false;
  diagnosticsText = '';

  now = new Date();
  private clockId: any;
  private sub?: Subscription;
  
  // CPF input functionality
  cpfDigits = '';

  constructor(
    private route: ActivatedRoute,
    public sdk: FaceSdkService,
    private times: TimesService,
    private router: Router
  ) {
    const t = this.route.snapshot.paramMap.get('tipo') as any;
    this.tipo = t ?? 'entrada';
  }

  async ngAfterViewInit() {
    try {
      this.statusMsg = 'Iniciando câmera...';
      
      // Aguarda um pouco para garantir que o DOM está pronto
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await this.startCamera();
    } catch (e: any) {
      console.error('Erro no checkin:', e);
      this.handleCameraError(e);
    }
  }

  async startCamera() {
    try {
      this.statusMsg = 'Solicitando acesso à câmera...';

      // Aguarda um pouco para garantir que o DOM está pronto
      await new Promise(resolve => setTimeout(resolve, 500));

      // Tenta múltiplas abordagens para máxima compatibilidade
      let stream: MediaStream | null = null;
      let error: any = null;

      // Abordagem 1: API moderna
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const constraints = {
            video: {
              facingMode: 'user',
              width: { ideal: 640 },
              height: { ideal: 480 }
            },
            audio: false
          };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
          error = e;
        }
      }

      // Abordagem 2: API antiga (fallback)
      if (!stream && (navigator as any).getUserMedia) {
        try {
          const constraints = {
            video: {
              facingMode: 'user',
              width: { ideal: 640 },
              height: { ideal: 480 }
            },
            audio: false
          };
          stream = await new Promise((resolve, reject) => {
            (navigator as any).getUserMedia(constraints, resolve, reject);
          });
        } catch (e) {
          error = e;
        }
      }

      // Abordagem 3: Configuração mínima
      if (!stream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const constraints = {
            video: true,
            audio: false
          };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
          error = e;
        }
      }

      // Se nenhuma abordagem funcionou
      if (!stream) {
        throw error || new Error('getUserMedia não está disponível');
      }
      
      // Conecta o stream ao elemento de vídeo
      this.videoEl.nativeElement.srcObject = stream;
      await this.videoEl.nativeElement.play();

      this.statusMsg = 'Câmera iniciada com sucesso!';
      this.cameraPermissionGranted = true;

      // Inicia o relógio
      this.clockId = setInterval(() => { this.now = new Date(); }, 1000);

      // Inicializa o SDK do Luxand
      if (!this.sdk.FSDK) {
        this.statusMsg = 'Carregando SDK de reconhecimento facial...';
        await this.sdk.init();
      }

      this.statusMsg = 'Iniciando reconhecimento facial...';
      await this.sdk.startCamera(this.videoEl.nativeElement, this.canvasEl.nativeElement);

      // Monitora detecções
      let registrado = false;
      this.sub = this.sdk.lastInfo$.subscribe(info => {
        if (!registrado && info.detected && info.liveness >= 0.6 && info.name && info.name !== 'Desconhecido') {
          this.times.registrar(this.tipo, info.name, new Date());
          this.statusMsg = `${this.label(this.tipo)} registrado para ${info.name}`;
          this.ok = true;
          registrado = true;
          setTimeout(() => this.router.navigateByUrl('/'), 1200);
        } else if (!registrado) {
          this.statusMsg = 'Detectando... mantenha o rosto visível';
        }
      });

    } catch (e: any) {
      console.error('Erro ao iniciar câmera:', e);
      this.handleCameraError(e);
    }
  }

  async requestCameraPermission() {
    try {
      this.statusMsg = 'Solicitando permissão de câmera...';
      this.showPermissionButton = false;

      // Tenta iniciar a câmera novamente
      await this.startCamera();

    } catch (e: any) {
      console.error('Erro ao solicitar permissão:', e);
      this.handleCameraError(e);
      this.showPermissionButton = true;
    }
  }

  handleCameraError(e: any) {
    console.error('Erro detalhado:', e);
    
    if (e.message === 'getUserMedia não está disponível') {
      this.statusMsg = 'Seu navegador não suporta acesso à câmera. Tente usar Firefox ou Chrome atualizado.';
    } else if (e.name === 'NotAllowedError') {
      this.statusMsg = 'Permissão de câmera negada. Toque no ícone da câmera na barra de endereços e permita o acesso.';
      this.showPermissionButton = true;
    } else if (e.name === 'NotFoundError') {
      this.statusMsg = 'Nenhuma câmera encontrada no dispositivo.';
    } else if (e.name === 'NotReadableError') {
      this.statusMsg = 'Câmera em uso por outro aplicativo. Feche outros apps e tente novamente.';
    } else if (e.name === 'OverconstrainedError') {
      this.statusMsg = 'Configurações de câmera não suportadas. Tentando configurações mais simples...';
      // Tenta novamente com configurações mais simples
      setTimeout(() => this.startCamera(), 1000);
    } else {
      this.statusMsg = `Erro: ${e.message || e.name || 'Erro desconhecido'}`;
    }
  }

  async buildDiagnostics(): Promise<string> {
    const isSecure = (window as any).isSecureContext;
    const ua = navigator.userAgent;
    const hasMediaDevices = !!navigator.mediaDevices;
    const hasModernGUM = !!navigator.mediaDevices?.getUserMedia;
    const hasLegacyGUM = !!(navigator as any).getUserMedia;
    const protocol = location.protocol;
    const host = location.hostname;
    let perm = 'desconhecido';
    try {
      if ((navigator as any).permissions?.query) {
        const res = await (navigator as any).permissions.query({ name: 'camera' as any });
        perm = res.state;
      }
    } catch {}
    return [
      `isSecureContext: ${isSecure}`,
      `protocol: ${protocol}`,
      `host: ${host}`,
      `userAgent: ${ua}`,
      `mediaDevices: ${hasMediaDevices}`,
      `modern getUserMedia: ${hasModernGUM}`,
      `legacy getUserMedia: ${hasLegacyGUM}`,
      `permission(camera): ${perm}`
    ].join('\n');
  }

  async toggleDiagnostics() {
    this.showDiagnostics = !this.showDiagnostics;
    if (this.showDiagnostics) {
      this.diagnosticsText = await this.buildDiagnostics();
    }
  }

  showHttpsSolutions(browserInfo: any) {
    const currentUrl = window.location.href;
    const isHttps = currentUrl.startsWith('https://');
    const isLocalhost = currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1');
    
    let solutions = `
🔒 SOLUÇÃO HTTPS PARA ${browserInfo.name.toUpperCase()}

📱 NO CELULAR:
${browserInfo.name} exige HTTPS para acesso à câmera.

SOLUÇÕES DISPONÍVEIS:

1️⃣ **LOCALTUNNEL (Recomendado):**
   - URL HTTPS: https://luxand-camera.loca.lt
   - Funciona em qualquer dispositivo
   - Não precisa instalar nada

2️⃣ **NGROK:**
   - Execute: ngrok http 4200
   - Use a URL HTTPS que aparecer
   - Mais estável que localtunnel

3️⃣ **LOCALHOST (Apenas computador):**
   - URL: http://localhost:4200
   - Funciona apenas no computador
   - Não funciona no celular

4️⃣ **CHROME COM FLAGS (Desenvolvimento):**
   - Execute: chrome-flags.bat
   - Permite HTTP para desenvolvimento
   - Apenas para testes locais

🌐 URL ATUAL: ${currentUrl}
🔒 HTTPS: ${isHttps ? '✅ Sim' : '❌ Não'}
🏠 Localhost: ${isLocalhost ? '✅ Sim' : '❌ Não'}
🌍 Navegador: ${browserInfo.name} ${browserInfo.version}
    `;
    
    alert(solutions);
  }

  showCameraInstructions() {
    const currentUrl = window.location.href;
    const isHttps = currentUrl.startsWith('https://');
    const isLocalhost = currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1');
    
    let instructions = `
Para permitir acesso à câmera:

📱 NO CELULAR:
1. Toque no ícone de câmera na barra de endereços
2. Selecione "Permitir" ou "Allow"
3. Ou vá em Configurações > Privacidade > Câmera

💻 NO COMPUTADOR:
1. Clique no ícone de câmera na barra de endereços
2. Selecione "Permitir" ou "Allow"
3. Ou vá em Configurações do navegador

🔄 Se não funcionar:
- Recarregue a página
- Feche outros apps que usam câmera
`;

    if (!isHttps && !isLocalhost) {
      instructions += `
⚠️ PROBLEMA DE HTTPS:
Você está acessando via HTTP (${currentUrl})
Chrome exige HTTPS para câmera.

SOLUÇÕES:
1. Use localtunnel: https://luxand-camera.loca.lt
2. Use ngrok: ngrok http 4200
3. Ou acesse via localhost: http://localhost:4200
`;
    }

    instructions += `
🌐 URL ATUAL: ${currentUrl}
🔒 HTTPS: ${isHttps ? '✅ Sim' : '❌ Não'}
🏠 Localhost: ${isLocalhost ? '✅ Sim' : '❌ Não'}
    `;
    
    alert(instructions);
  }

  ngOnDestroy() {
    if (this.clockId) clearInterval(this.clockId);
    this.sub?.unsubscribe();
  }

  label(t: string) {
    switch (t) {
      case 'entrada': return 'Entrada';
      case 'pausa':   return 'Pausa';
      case 'retorno': return 'Retorno';
      case 'saida':   return 'Saída';
      default:        return t;
    }
  }

  // CPF formatting and keypad functionality
  formatCPF(nums: string): string {
    const s = nums.replace(/\D/g, "").slice(0, 11);
    if (s.length <= 3) return s;
    if (s.length <= 6) return s.slice(0, 3) + "." + s.slice(3);
    if (s.length <= 9)
      return s.slice(0, 3) + "." + s.slice(3, 6) + "." + s.slice(6);
    return (
      s.slice(0, 3) +
      "." +
      s.slice(3, 6) +
      "." +
      s.slice(6, 9) +
      "-" +
      s.slice(9)
    );
  }

  get formattedCPF(): string {
    return this.formatCPF(this.cpfDigits);
  }

  onKeypadClick(key: string) {
    if (key === "erase") {
      this.cpfDigits = this.cpfDigits.slice(0, -1);
    } else if (/^\d$/.test(key) && this.cpfDigits.length < 11) {
      this.cpfDigits += key;
    }
  }

  reloadPage() {
    window.location.reload();
  }
}
