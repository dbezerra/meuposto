import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TimesService } from '../../core/times.service';
import { FaceSdkService } from '../../face-sdk.service';

@Component({
  standalone: true,
  imports: [CommonModule, RouterModule],
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css']
})

export class HomeComponent {
  agora = new Date();
  dia!: { entrada?: string; pausa?: string; retorno?: string; saida?: string; nome?: string };
  ultimas: { nome: string; tipo: 'entrada'|'pausa'|'retorno'|'saida'; quandoISO: string; fotoDataUrl?: string }[] = [];

  constructor(private times: TimesService,private sdk: FaceSdkService) {
    this.dia = this.times.getHoje();               
    setInterval(() => this.agora = new Date(), 1000);

    // garante que a câmera esteja desligada nesta tela
    this.sdk.stopCamera();
    // 1x no início: baixa fotos e cadastra
    this.sdk.seedPortalOnce('D MG 01');

    // carrega últimas marcações
    this.ultimas = this.times.getUltimas(5);
  }

  get dataFormatada() {
    return this.agora.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
  }

  atualizar() {
    this.dia = this.times.getHoje();
    this.ultimas = this.times.getUltimas(5);
  }

  label(tipo: 'entrada'|'pausa'|'retorno'|'saida') {
    switch (tipo) {
      case 'entrada': return 'Entrada';
      case 'pausa': return 'Pausa';
      case 'retorno': return 'Retorno';
      case 'saida': return 'Saída';
    }
  }
}
