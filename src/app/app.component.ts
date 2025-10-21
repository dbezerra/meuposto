import { Component } from '@angular/core';
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
export class AppComponent {
  private deferredPrompt: any = null;
  showInstall = false;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeinstallprompt', (e: Event) => {
        e.preventDefault();
        this.deferredPrompt = e as any;
        const installed = localStorage.getItem('pwaInstalled') === '1';
        const dismissed = localStorage.getItem('pwaInstallDismissed') === '1';
        if (!installed && !dismissed) {
          this.showInstall = true;
        }
      });

      window.addEventListener('appinstalled', () => {
        this.deferredPrompt = null;
        this.showInstall = false;
        try { localStorage.setItem('pwaInstalled', '1'); } catch {}
      });
    }
  }

  async install() {
    if (!this.deferredPrompt) { return; }
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
  }

  dismiss() {
    this.showInstall = false;
    try { localStorage.setItem('pwaInstallDismissed', '1'); } catch {}
  }
}
