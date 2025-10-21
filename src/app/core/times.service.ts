import { Injectable } from '@angular/core';

type Tipo = 'entrada'|'pausa'|'retorno'|'saida';
export type Dia = { entrada?: string; pausa?: string; retorno?: string; saida?: string; nome?: string };
export type Marcacao = { nome: string; tipo: Tipo; quandoISO: string; fotoDataUrl?: string };

@Injectable({ providedIn: 'root' })
export class TimesService {
  private historyKey = 'apont-hist-v1';
  private keyFor(date = new Date()) {
    const d = date.toISOString().slice(0,10); // YYYY-MM-DD
    return `apont-${d}`;
  }

  getHoje(): Dia {
    const raw = localStorage.getItem(this.keyFor());
    return raw ? JSON.parse(raw) : {};
  }

  salvarHoje(dia: Dia) {
    localStorage.setItem(this.keyFor(), JSON.stringify(dia));
  }

  registrar(tipo: Tipo, nome: string, quando = new Date(), fotoDataUrl?: string) {
    const dia = this.getHoje();
    const hhmm = quando.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    dia[tipo] = hhmm;
    dia.nome = nome;
    this.salvarHoje(dia);

    // Atualiza histórico de últimas marcações
    this.pushHistorico({ nome, tipo, quandoISO: quando.toISOString(), fotoDataUrl });
    return dia;
  }

  getUltimas(max = 5): Marcacao[] {
    const raw = localStorage.getItem(this.historyKey);
    const arr: Marcacao[] = raw ? JSON.parse(raw) : [];
    // retorna mais recentes primeiro
    return arr
      .sort((a,b) => (b.quandoISO || '').localeCompare(a.quandoISO || ''))
      .slice(0, max);
  }

  private pushHistorico(item: Marcacao, max = 20) {
    const raw = localStorage.getItem(this.historyKey);
    const arr: Marcacao[] = raw ? JSON.parse(raw) : [];
    arr.unshift(item);
    // limita tamanho
    const trimmed = arr.slice(0, max);
    localStorage.setItem(this.historyKey, JSON.stringify(trimmed));
  }
}
