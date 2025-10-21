import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  template: `
    <router-outlet></router-outlet>

    <div *ngIf="showInstall" style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1000;background:#0d9488;color:#fff;padding:12px 16px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,0.2);display:flex;gap:12px;align-items:center;">
      <span>Instalar o Meu Posto neste dispositivo?</span>
      <button (click)="install()" style="background:#065f5b;color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;">Instalar</button>
      <button (click)="dismiss()" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.7);padding:8px 12px;border-radius:8px;cursor:pointer;">Agora não</button>
    </div>
  `
})
export class AppComponent implements OnInit {
  private deferredPrompt: any = null;
  showInstall = false;

  ngOnInit() {
    this.setupInstallPrompt();
  }

  private setupInstallPrompt() {
    if (typeof window === 'undefined') return;

    // Verifica se já foi instalado ou dispensado
    const installed = localStorage.getItem('pwaInstalled') === '1';
    const dismissed = localStorage.getItem('pwaInstallDismissed') === '1';
    
    if (installed || dismissed) {
      return;
    }

    // Listener para o evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      console.log('beforeinstallprompt triggered');
      e.preventDefault();
      this.deferredPrompt = e as any;
      this.showInstall = true;
    });

    // Listener para quando o app é instalado
    window.addEventListener('appinstalled', () => {
      console.log('App installed');
      this.deferredPrompt = null;
      this.showInstall = false;
      try { localStorage.setItem('pwaInstalled', '1'); } catch {}
    });

    // Fallback: mostra o banner após 3 segundos se não houve beforeinstallprompt
    // Isso funciona para desenvolvimento ou quando os critérios PWA não são atendidos
    setTimeout(() => {
      if (!this.deferredPrompt && !installed && !dismissed) {
        console.log('Showing fallback install prompt');
        this.showInstall = true;
      }
    }, 3000);
  }

  async install() {
    if (this.deferredPrompt) {
      // Instalação real via PWA
      try {
        await this.deferredPrompt.prompt();
        const { outcome } = await this.deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          try { localStorage.setItem('pwaInstalled', '1'); } catch {}
        }
      } finally {
        this.deferredPrompt = null;
        this.showInstall = false;
      }
    } else {
      // Fallback: instruções para instalação manual
      alert('Para instalar o Meu Posto:\n\n' +
            'Chrome/Edge: Clique no ícone de instalação na barra de endereços\n' +
            'Firefox: Clique no ícone "+" na barra de endereços\n' +
            'Safari: Toque em "Compartilhar" e depois "Adicionar à Tela de Início"');
      this.dismiss();
    }
  }

  dismiss() {
    this.showInstall = false;
    try { localStorage.setItem('pwaInstallDismissed', '1'); } catch {}
  }
}
