import { Injectable } from '@angular/core';

type Tipo = 'entrada'|'pausa'|'retorno'|'saida';
export type Dia = { entrada?: string; pausa?: string; retorno?: string; saida?: string; nome?: string };

@Injectable({ providedIn: 'root' })
export class TimesService {
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

  registrar(tipo: Tipo, nome: string, quando = new Date()) {
    const dia = this.getHoje();
    const hhmm = quando.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    dia[tipo] = hhmm;
    dia.nome = nome;
    this.salvarHoje(dia);
    return dia;
  }
}
