import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../environments/environment';
import { HttpClient, HttpParams,HttpHeaders  } from '@angular/common/http';
import { firstValueFrom, catchError } from 'rxjs';

// Import dinâmico dos wrappers .js que você copiou para src/app/luxand
// (o TS aceita devido ao "allowJs": true)
const simdWrapperPath = () => import('./luxand/fsdk_wasm_wrapper_simd.js');
const baseWrapperPath = () => import('./luxand/fsdk_wasm_wrapper.js');

type FSDKType = any;

interface PortalFace {
  matricula: string;
  nome: string;
  CPF: string;
  fotoBase64: string;   // pode vir como dataURL completo ou base64 “puro”
}

interface PortalResp {
  results: PortalFace[];
}

@Injectable({ providedIn: 'root' })
export class FaceSdkService {
  // Estados e “sinais” para o componente ouvir
  log$ = new BehaviorSubject<string>('Inicializando...\n');
  userList$ = new BehaviorSubject<string[]>([]);
  lastInfo$ = new BehaviorSubject<{name: string; liveness: number; detected: boolean}>({name: 'Desconhecido', liveness: 0, detected: false});

  FSDK: FSDKType | null = null;
  tracker: number = -1;

  private drawTimer: any = null;
  private frameIntervalMs = 50;

  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'LuxandFaceDB';
  private readonly STORE_NAME = 'trackerData';

  private faces: any = null;         // retorno do FeedFrame
  private cameraStarted = false;
  private isTrackerReady = false;

  private mediaStream: MediaStream | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private currentCanvas: HTMLCanvasElement | null = null;
  private boxEma: { left: number; top: number; size: number } | null = null;
  private lastBox: { left: number; top: number; size: number } | null = null;
  private lastFaceTs = 0;
  private emaAlpha = 0.2;     // suavização da caixa (0.15–0.3)
  private keepMs = 220;       // segura a caixa por 220ms quando um frame falha
  private liveScore = 0;
  private liveIsGood = false;
  private liveHi = 0.62;      // sobe para "vivo" acima de 0.62
  private liveLo = 0.55;      // cai para "não vivo" abaixo de 0.55
  private liveAlpha = 0.30;   // suavização do score
  private stableFrames = 0;   // exige 2 frames seguidos para "assentar"
  private minStableFrames = 2;
  // private simFace = 7
  private ema(prev: number, next: number, a: number) { return prev * (1 - a) + next * a; }

  private authHeaders(): HttpHeaders {
    const token = btoa(`${environment.basicAuthUser}:${environment.basicAuthPass}`);
    return new HttpHeaders({ Authorization: `Basic ${token}` });
  }

  private smoothBox(left: number, top: number, size: number) {
    if (!this.boxEma) this.boxEma = { left, top, size };
    else {
      this.boxEma.left = this.ema(this.boxEma.left, left, this.emaAlpha);
      this.boxEma.top  = this.ema(this.boxEma.top,  top,  this.emaAlpha);
      this.boxEma.size = this.ema(this.boxEma.size, size, this.emaAlpha);
    }
    this.lastBox = { ...this.boxEma };
    return this.lastBox;
  }

  
  private updateLive(score: number) {
    this.liveScore = this.ema(this.liveScore || score, score, this.liveAlpha);
    if (this.liveIsGood) {
      if (this.liveScore < this.liveLo) this.liveIsGood = false;
    } else {
      if (this.liveScore > this.liveHi) this.liveIsGood = true;
    }
    return { score: this.liveScore, isLive: this.liveIsGood };
  }

  constructor(private zone: NgZone, private http: HttpClient ) {}

    
    private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

    // Converte um dataURL/base64 qualquer em PNG ArrayBuffer usando canvas
    private async dataUrlToPngArrayBuffer(dataUrl: string): Promise<ArrayBuffer> {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = dataUrl;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png', 1)!);
      return await blob.arrayBuffer();
    }

    private normalizePortalJson(raw: string): { results: any[] } {
      let s = raw.trim();

      // caso 1: veio como STRING com escapes → desescapa
      if (s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1);          // remove aspas externas
        s = s.replace(/\\"/g, '"');  // desescapa aspas internas
      }

      // caso 2: veio só o fragmento results:[...] → embrulha em objeto
      if (!s.startsWith('{')) {
        s = `{${s}}`;
      }

      try {
        const obj = JSON.parse(s);
        const arr = Array.isArray(obj.results) ? obj.results : [];
        return { results: arr };
      } catch (e) {
        console.error('[seed] JSON inválido recebido do portal:', s.slice(0, 300));
        throw e;
      }
    }

    // Variante para string base64 “pura” (sem prefixo data:)
    private base64ToDataUrlJPEG(b64: string) {
      // se já vier com "data:image/..." retorna como está
      if (/^data:image\//i.test(b64)) return b64;
      return `data:image/jpeg;base64,${b64}`;
    }

    async registerFromArrayBuffer(pngArrayBuffer: ArrayBuffer, userName: string) {
      if (!this.FSDK || this.tracker === -1) throw new Error('Tracker não pronto');

      const a = new Uint8Array(pngArrayBuffer);
      const buf = this.FSDK._malloc(a.length);
      try {
        this.FSDK.HEAPU8.set(a, buf);
        const img = this.FSDK.LoadImageFromPngBuffer(buf, a.length);
        if (img < 0) throw new Error('Falha ao carregar imagem');

        this.FSDK.DetectFace(img);

        // tenta alimentar o mesmo frame várias vezes
        let faces = this.FSDK.FeedFrame(this.tracker, img);
        for (let i = 0; (!faces || faces.size() === 0) && i < 7; i++) {
          await new Promise(r => setTimeout(r, 16));
          faces = this.FSDK.FeedFrame(this.tracker, img);
        }
        this.FSDK.FreeImage(img);

        if (!faces || faces.size() === 0) throw new Error('Nenhum rosto detectado');

        const faceId = faces.get(0);
        this.FSDK.SetName(this.tracker, faceId, userName);
        await this.saveTracker();
        await this.updateRegisteredUserList?.();
      } finally {
        this.FSDK._free(buf);
      }
    }


    // seed para alimentar o storage com as fotos do backend
    private seeding = false;
    private seededOnce = false;

    /** Baixa fotos da API e cadastra no tracker. Chamar 1x ao abrir o app. */
    async seedFromPortalPrestador(filial: string = 'D MG 01', force = false) {
      
      if (this.seeding || this.seededOnce) {
        console.log('⚠️ Seed já em andamento ou já executado. Seeding:', this.seeding, 'SeededOnce:', this.seededOnce);
        return;
      }
      if (!this.FSDK || this.tracker === -1) {
        console.log('🔧 Inicializando SDK...');
        await this.init(); // garante SDK
      }

      this.seeding = true;
      try {
        console.log('📡 Fazendo chamada para API do Portal Prestador (auto-env)...');

        // Verifica se há dados offline primeiro
        const offlineData = await this.getOfflinePortalData(filial);
        if (offlineData && offlineData.length > 0) {
          console.log('📦 Usando dados offline encontrados:', offlineData.length, 'registros');
          await this.processPortalData(offlineData, filial);
          this.seededOnce = true;
          return;
        }

        // Se não há dados offline, tenta buscar online
        const params = new HttpParams().set('filial', filial);
        const headers = this.authHeaders();

        // Choose endpoint based on runtime environment:
        // - Dev (ng serve): use Angular proxy at /rest
        // - Prod (Vercel/HTTPS): use serverless function at /api
        const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';
        const endpoint = isHttps ? '/api/portalprestador/fotofunc' : '/rest/PORTALPRESTADOR/fotofunc';

        // *** pega como TEXTO ***
        const raw = await firstValueFrom(
          this.http.get(endpoint, {
            params, headers, responseType: 'text'
          }).pipe(
            // Adiciona timeout e retry para melhor compatibilidade com Safari
            catchError(error => {
              console.warn('Erro na requisição HTTP:', error);
              throw error;
            })
          )
        );
        
        console.log('📥 Resposta recebida da API:', raw.substring(0, 100) + '...');

        const resp = this.normalizePortalJson(raw);   // -> { results: [...] }
        const results = resp.results ?? [];
        
        console.log('📊 Resultados encontrados:', results.length);

        // Salva dados offline para uso futuro
        await this.saveOfflinePortalData(filial, results);

        await this.processPortalData(results, filial);
        this.seededOnce = true;
        console.log('🎉 Seed finalizado. Total processado:', results.length);
      } catch (e) {
        console.error('❌ Seed falhou:', e);
        // Tenta usar dados offline mesmo se a API falhou
        const offlineData = await this.getOfflinePortalData(filial);
        if (offlineData && offlineData.length > 0) {
          console.log('🔄 Tentando usar dados offline após falha da API...');
          await this.processPortalData(offlineData, filial);
          this.seededOnce = true;
        } else {
          throw e;
        }
      } finally {
        this.seeding = false;
      }
    }

    /** Chama o seed de forma segura (idempotente) */
    async seedPortalOnce(filial = 'D MG 01') {
      console.log('🌱 Iniciando seed do Portal Prestador para filial:', filial);
      try { 
        await this.seedFromPortalPrestador(filial); 
        console.log('✅ Seed do Portal Prestador concluído com sucesso');
      } catch (e) { 
        console.error('❌ Seed falhou:', e); 
      }
    }

    /** Processa dados do portal (online ou offline) */
    private async processPortalData(results: PortalFace[], filial: string) {
      for (const r of results) {
        try {
          const dataUrl = this.base64ToDataUrlJPEG(r.fotoBase64);
          const pngAb = await this.dataUrlToPngArrayBuffer(dataUrl);
          const nome = (r.nome || r.matricula || '').trim() || r.CPF || `id_${r.matricula}`;
          this.saveAvatar(nome, dataUrl);
          await this.registerFromArrayBuffer(pngAb, nome);
          console.log('✅ Registrado:', nome);
        } catch (e) {
          console.warn('Seed: falha ao registrar', r?.matricula, e);
        }
        // small yield para não travar a UI
        await new Promise(r => setTimeout(r, 0));
      }
    }

    /** Salva dados do portal offline para uso futuro */
    private async saveOfflinePortalData(filial: string, data: PortalFace[]) {
      try {
        const key = `portalData_${filial}`;
        const dataWithTimestamp = {
          data,
          timestamp: Date.now(),
          filial
        };
        localStorage.setItem(key, JSON.stringify(dataWithTimestamp));
        console.log('💾 Dados do portal salvos offline para filial:', filial);
      } catch (e) {
        console.warn('Erro ao salvar dados offline:', e);
      }
    }

    /** Recupera dados do portal salvos offline */
    private async getOfflinePortalData(filial: string): Promise<PortalFace[] | null> {
      try {
        const key = `portalData_${filial}`;
        const stored = localStorage.getItem(key);
        if (!stored) return null;

        const parsed = JSON.parse(stored);
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 dias
        const isExpired = Date.now() - parsed.timestamp > maxAge;

        if (isExpired) {
          console.log('🗑️ Dados offline expirados para filial:', filial);
          localStorage.removeItem(key);
          return null;
        }

        console.log('📦 Dados offline encontrados para filial:', filial, 'Registros:', parsed.data.length);
        return parsed.data;
      } catch (e) {
        console.warn('Erro ao recuperar dados offline:', e);
        return null;
      }
    }

    private avatarKey(name: string) {
      return `avatar:${(name || '').trim()}`;
    }

    saveAvatar(name: string, dataUrl: string) {
      try {
        localStorage.setItem(this.avatarKey(name), dataUrl);
      } catch {}
    }

    getAvatar(name: string): string | null {
      try {
        return localStorage.getItem(this.avatarKey(name));
      } catch { return null; }
    }

    
    /** Alimenta o mesmo frame várias vezes até detectar ao menos 1 rosto */
    private async feedUntilFace(img: number, maxTries = 8, pauseMs = 16) {
        let faces: any = null;
        for (let i = 0; i < maxTries; i++) {
            faces = this.FSDK!.FeedFrame(this.tracker, img);
            if (faces && typeof faces.size === 'function' && faces.size() > 0) return faces;
            await this.sleep(pauseMs);
        }
      return faces; // null ou size() == 0
    }

  // Tenta resolver diferenças de nomes de função entre builds do Luxand
    private pickF<T extends (...args: any[]) => any>(...names: string[]): T | null {
        const F: any = this.FSDK;
        if (!F) return null;
        for (const n of names) {
            if (typeof F[n] === 'function') return F[n].bind(F) as T;
            if (typeof F['_' + n] === 'function') return F['_' + n].bind(F) as T; // alguns builds expõem com "_" também
        }
        return null;
    }


  // === Utils de log ===
  private log(msg: string) {
    const old = this.log$.value;
    this.log$.next(old + msg + '\n');
  }

  // === Checagens ===
  private isWasmSupported(): boolean {
    try {
      if (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function') {
        const mod = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
        return mod instanceof WebAssembly.Module && new WebAssembly.Instance(mod) instanceof WebAssembly.Instance;
      }
    } catch {}
    return false;
  }

  private async simdSupported(): Promise<boolean> {
    try {
      return WebAssembly.validate(
        new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])
      );
    } catch {
      return false;
    }
  }

  // === IndexedDB ===
  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = (e: any) => {
        const db: IDBDatabase = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };
      req.onsuccess = (e: any) => {
        this.db = e.target.result as IDBDatabase;
        resolve(this.db!);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async saveTrackerDataToIndexedDB(data: Uint8Array) {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const putReq = store.put(data, 'luxandTracker');
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    });
  }

  private async loadTrackerDataFromIndexedDB(): Promise<Uint8Array | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const getReq = store.get('luxandTracker');
      getReq.onsuccess = () => resolve(getReq.result ?? null);
      getReq.onerror = () => reject(getReq.error);
    });
  }

  private async clearTrackerDataFromIndexedDB() {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const clearReq = store.clear();
      clearReq.onsuccess = () => resolve();
      clearReq.onerror = () => reject(clearReq.error);
    });
  }

    /** Traça uma elipse. Usa ctx.ellipse quando disponível; senão, Béziers (fallback). */
  private strokeEllipse(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, rx: number, ry: number
  ) {
    const anyCtx = ctx as any;
    if (typeof anyCtx.ellipse === 'function') {
      ctx.beginPath();
      anyCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    // Fallback via 4 curvas Bézier (kappa)
    const k = 0.5522847498307936;
    const ox = rx * k;
    const oy = ry * k;

    ctx.beginPath();
    ctx.moveTo(cx + rx, cy);
    ctx.bezierCurveTo(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry);
    ctx.bezierCurveTo(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy);
    ctx.bezierCurveTo(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry);
    ctx.bezierCurveTo(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy);
    ctx.closePath();
    ctx.stroke();
  }

  /** Desenha um retângulo arredondado (compatível).
 *  r pode ser número (raio) ou objeto {tl,tr,br,bl} para raios por canto.
 */
  private strokeRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    r: number | {tl:number; tr:number; br:number; bl:number} = 12
  ) {
    const rr = typeof r === 'number'
      ? { tl: r, tr: r, br: r, bl: r }
      : r;

    // Chrome/Edge/Firefox modernos já têm roundRect:
    const anyCtx = ctx as any;
    if (typeof anyCtx.roundRect === 'function') {
      ctx.beginPath();
      anyCtx.roundRect(x, y, w, h, [rr.tl, rr.tr, rr.br, rr.bl]);
      ctx.stroke();
      return;
    }

    // Fallback com arcTo (funciona em todos)
    const rtl = Math.min(rr.tl, w/2, h/2);
    const rtr = Math.min(rr.tr, w/2, h/2);
    const rbr = Math.min(rr.br, w/2, h/2);
    const rbl = Math.min(rr.bl, w/2, h/2);

    ctx.beginPath();
    ctx.moveTo(x + rtl, y);
    ctx.lineTo(x + w - rtr, y);
    ctx.arcTo(x + w, y, x + w, y + rtr, rtr);
    ctx.lineTo(x + w, y + h - rbr);
    ctx.arcTo(x + w, y + h, x + w - rbr, y + h, rbr);
    ctx.lineTo(x + rbl, y + h);
    ctx.arcTo(x, y + h, x, y + h - rbl, rbl);
    ctx.lineTo(x, y + rtl);
    ctx.arcTo(x, y, x + rtl, y, rtl);
    ctx.closePath();
    ctx.stroke();
  }

  // === Inicialização principal ===
  async init(): Promise<void> {
    if (!this.isWasmSupported()) {
      this.log('Seu navegador não suporta WebAssembly.');
      throw new Error('WebAssembly não suportado');
    }

    const hasSIMD = await this.simdSupported();
    this.log(hasSIMD ? 'SIMD suportado' : 'SIMD NÃO suportado');

    // importa wrapper correto
    const wrapperModule = hasSIMD ? await simdWrapperPath() : await baseWrapperPath();

    // MUITO IMPORTANTE: apontar onde estão os .wasm
    // Aqui garantimos que o emscripten procure o wasm em /assets/luxand/
    const fsdk: FSDKType = await wrapperModule.default({
      locateFile: (path: string) => `assets/luxand/${path}`
    });

    this.FSDK = fsdk;
    await (this.FSDK.ready ?? Promise.resolve());

    // Ativar e inicializar
    const ret = this.FSDK.ActivateLibrary(environment.LUXAND_KEY);
    if (ret !== 0) {
      this.log(`Falha na ativação do FaceSDK: código ${ret}`);
      throw new Error('FaceSDK não ativado');
    }

    this.FSDK.Initialize();
    this.log('FSDK ativado e inicializado.');

    // Criar ou carregar tracker do IndexedDB
    await this.setupTracker();
  }

  private async setupTracker() {
    if (!this.FSDK) throw new Error('FSDK ausente');

    const stored = await this.loadTrackerDataFromIndexedDB();
    if (stored) {
      // carregar do buffer
      const dataBuf = this.FSDK._malloc(stored.length);
      this.FSDK.HEAPU8.set(stored, dataBuf);
      this.tracker = this.FSDK.LoadTrackerMemoryFromBuffer(dataBuf);
      this.FSDK._free(dataBuf);
      this.log('Tracker carregado do IndexedDB.');
    } else {
      this.tracker = this.FSDK.CreateTracker();
      // parâmetros mais amigáveis
      this.FSDK.SetTrackerMultipleParameters(
        this.tracker,
        'HandleArbitraryRotations=false; DetermineFaceRotationAngle=false; InternalResizeWidth=256; FaceDetectionThreshold=3;'
      );
      this.log('Novo tracker criado.');
    }

    // liveness
    this.FSDK.SetTrackerParameter(this.tracker, 'DetectLiveness', 'true');
    this.FSDK.SetTrackerParameter(this.tracker, 'SmoothAttributeLiveness', 'true');
    this.FSDK.SetTrackerParameter(this.tracker, 'AttributeLivenessSmoothingAlpha', '0.6');
    this.FSDK.SetTrackerParameter(this.tracker, 'LivenessFramesCount', '8');

    this.isTrackerReady = true;
    await this.updateRegisteredUserList();
  }

  // === Detecção de Navegador e Compatibilidade ===
  getBrowserInfo(): { name: string; version: string; supportsCamera: boolean; requiresHttps: boolean } {
    const userAgent = navigator.userAgent;
    let browserName = 'Unknown';
    let version = 'Unknown';
    let supportsCamera = true; // Assume que suporta por padrão
    let requiresHttps = true;

    // Detecção do navegador mais precisa
    if (userAgent.includes('Chrome') && !userAgent.includes('Edge') && !userAgent.includes('OPR')) {
      browserName = 'Chrome';
      const match = userAgent.match(/Chrome\/(\d+)/);
      version = match ? match[1] : 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    } else if (userAgent.includes('Firefox')) {
      browserName = 'Firefox';
      const match = userAgent.match(/Firefox\/(\d+)/);
      version = match ? match[1] : 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browserName = 'Safari';
      const match = userAgent.match(/Version\/(\d+)/);
      version = match ? match[1] : 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    } else if (userAgent.includes('Edge')) {
      browserName = 'Edge';
      const match = userAgent.match(/Edge\/(\d+)/);
      version = match ? match[1] : 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    } else if (userAgent.includes('OPR')) {
      browserName = 'Opera';
      const match = userAgent.match(/OPR\/(\d+)/);
      version = match ? match[1] : 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    } else {
      // Para navegadores desconhecidos, assume que pode funcionar
      browserName = 'Navegador Desconhecido';
      version = 'Unknown';
      supportsCamera = true;
      requiresHttps = true;
    }

    // Verifica se getUserMedia está disponível (isso é mais importante)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      supportsCamera = false;
    }

    return { name: browserName, version, supportsCamera, requiresHttps };
  }

  // === Verificação de Compatibilidade ===
  checkBrowserCompatibility(): { supported: boolean; message: string; browserInfo: any } {
    const browserInfo = this.getBrowserInfo();
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.includes('192.168');
    
    console.log('Browser Info:', browserInfo);
    console.log('Is Secure:', isSecure, 'Is Localhost:', isLocalhost);
    console.log('getUserMedia available:', !!navigator.mediaDevices?.getUserMedia);
    console.log('navigator.mediaDevices:', !!navigator.mediaDevices);
    console.log('navigator.getUserMedia:', !!(navigator as any).getUserMedia);
    
    // Para localhost/IP local, sempre permite (desenvolvimento)
    if (isLocalhost) {
      return {
        supported: true,
        message: `${browserInfo.name} ${browserInfo.version} compatível (localhost)`,
        browserInfo
      };
    }

    // Verifica HTTPS apenas para URLs externas
    if (!isSecure && browserInfo.requiresHttps) {
      return {
        supported: false,
        message: `HTTPS necessário para ${browserInfo.name}. Use HTTPS ou localhost.`,
        browserInfo
      };
    }

    // Se chegou até aqui, está compatível
    return {
      supported: true,
      message: `${browserInfo.name} ${browserInfo.version} compatível`,
      browserInfo
    };
  }

  // === Verificação de Permissões ===
  async checkCameraPermissions(): Promise<boolean> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        return false;
      }
      
      // Tenta acessar a câmera para verificar permissões
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user' }, 
        audio: false 
      });
      
      // Se chegou até aqui, tem permissão
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (error: any) {
      console.log('Permissão de câmera:', error.name);
      return false;
    }
  }

  async forceCameraPermission(): Promise<boolean> {
    try {
      // Verifica getUserMedia de forma mais robusta
      const getUserMedia = navigator.mediaDevices?.getUserMedia || (navigator as any).getUserMedia;
      if (!getUserMedia) {
        throw new Error('getUserMedia não suportado neste navegador');
      }

      // Tenta diferentes configurações de câmera
      const constraints = [
        // Configuração ideal para mobile
        {
          video: {
            facingMode: 'user',
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: false
        },
        // Configuração mais simples
        {
          video: {
            facingMode: 'user'
          },
          audio: false
        },
        // Configuração mínima
        {
          video: true,
          audio: false
        }
      ];

      for (const constraint of constraints) {
        try {
          console.log('Tentando configuração:', constraint);
          const stream = await getUserMedia.call(navigator.mediaDevices || navigator, constraint);

          // Para o stream imediatamente após obter permissão
          stream.getTracks().forEach(track => track.stop());
          console.log('Permissão obtida com sucesso');
          return true;
        } catch (error: any) {
          console.log('Falha na configuração:', constraint, error.message);
          if (constraint === constraints[constraints.length - 1]) {
            throw error; // Se é a última tentativa, relança o erro
          }
        }
      }

      return false;
    } catch (error: any) {
      console.error('Erro ao forçar permissão:', error);
      throw error;
    }
  }

  // === Câmera ===
  async startCamera(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    // se já houver algo rodando, para antes de iniciar de novo
    if (this.cameraStarted) await this.stopCamera();

    this.currentVideo = video;
    this.currentCanvas = canvas;

    // O stream já foi configurado no componente
    // Aqui apenas iniciamos o loop de desenho
    this.cameraStarted = true;

    // loop de desenho
    const loop = async () => {
      if (!this.cameraStarted) return; // guarda de segurança
      try {
        await this.drawFrame(video, canvas);
      } finally {
        if (this.cameraStarted) {
          this.drawTimer = setTimeout(loop, this.frameIntervalMs);
        }
      }
    };
    this.zone.runOutsideAngular(loop);
    this.log('SDK de reconhecimento facial iniciado.');
  }

async stopCamera() {
  // 1) para o loop de desenho
  if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }

  // 2) encerra TODAS as tracks do stream (vídeo/áudio)
  if (this.mediaStream) {
    try {
      const tracks = [
        ...this.mediaStream.getTracks(),
        ...this.mediaStream.getVideoTracks(),
        ...this.mediaStream.getAudioTracks(),
      ];
      tracks.forEach(t => { try { t.stop(); t.enabled = false; } catch {} });
    } catch {}
  }

  // 3) limpa o <video> de forma sincronizada
  if (this.currentVideo) {
    try { await this.currentVideo.pause(); } catch {}
    // @ts-ignore
    this.currentVideo.srcObject = null;
    this.currentVideo.removeAttribute('src');
    this.currentVideo.load?.();
  }

  // 4) zera referências (ajuda o GC a coletar)
  this.mediaStream   = null;
  this.currentVideo  = null;
  this.currentCanvas = null;

  // 5) estado interno
  this.cameraStarted = false;
  this.faces = null;

  // 6) reseta estados visuais
  this.lastInfo$.next({ name: 'Desconhecido', liveness: 0, detected: false });
  if ((this as any).boxEma !== undefined) (this as any).boxEma = null;
  if ((this as any).lastBox !== undefined) (this as any).lastBox = null;

  // 7) pequeno atraso dá tempo do hardware apagar o LED em alguns browsers
  await new Promise(r => setTimeout(r, 50));

  this.log('Câmera parada.');
}


// canvas de trabalho (offscreen) para gerar o PNG do frame
private workCanvas: HTMLCanvasElement | null = null;


private async drawFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<void> {
  if (!this.cameraStarted || !this.FSDK || this.tracker === -1) return;

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;

  // Overlay do mesmo tamanho do vídeo
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw; canvas.height = vh;
  }

  // Offscreen para PNG do frame
  if (!this.workCanvas) this.workCanvas = document.createElement('canvas');
  if (this.workCanvas.width !== vw || this.workCanvas.height !== vh) {
    this.workCanvas.width = vw; this.workCanvas.height = vh;
  }
  const wctx = this.workCanvas.getContext('2d')!;
  wctx.drawImage(video, 0, 0, vw, vh);

  const frameBlob: Blob = await new Promise(res => this.workCanvas!.toBlob(b => res(b!), 'image/png')!);
  await this.processFrame(frameBlob); // atualiza this.faces

  // Helpers locais
  const strokeEllipse = (ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) => {
    const anyCtx = ctx as any;
    if (typeof anyCtx.ellipse === 'function') {
      ctx.beginPath(); anyCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke(); return;
    }
    const k = 0.5522847498307936, ox = rx * k, oy = ry * k;
    ctx.beginPath();
    ctx.moveTo(cx + rx, cy);
    ctx.bezierCurveTo(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry);
    ctx.bezierCurveTo(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy);
    ctx.bezierCurveTo(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry);
    ctx.bezierCurveTo(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy);
    ctx.closePath(); ctx.stroke();
  };

  const fillRoundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    const rtl = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rtl, y);
    ctx.arcTo(x + w, y, x + w, y + h, rtl);
    ctx.arcTo(x + w, y + h, x, y + h, rtl);
    ctx.arcTo(x, y + h, x, y, rtl);
    ctx.arcTo(x, y, x + w, y, rtl);
    ctx.closePath();
    ctx.fill();
  };

  const drawLabelPill = (
    ctx: CanvasRenderingContext2D,
    text: string,
    box: { left: number; top: number; size: number },
    color: string
  ) => {
    ctx.save();
    ctx.font = '600 18px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const padX = 12, padY = 8, margin = 6;

    const m = ctx.measureText(text);
    const textH = (m.actualBoundingBoxAscent || 14) + (m.actualBoundingBoxDescent || 4);
    const w = m.width + padX * 2;
    const h = textH + padY * 2;

    const cx = box.left + box.size / 2;
    let x = Math.max(margin, Math.min(cx - w / 2, canvas.width - w - margin));
    let y = box.top + box.size + 8; // abaixo do rosto
    if (y + h > canvas.height - margin) y = canvas.height - h - margin;

    ctx.fillStyle = color;               // fundo colorido (visível)
    fillRoundedRect(ctx, x, y, w, h, 12);

    ctx.fillStyle = '#fff';              // texto branco
    ctx.fillText(text, x + padX, y + padY + (textH - (m.actualBoundingBoxDescent || 4)));
    ctx.restore();
  };

  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now = performance.now();

  if (this.faces && this.faces.size && this.faces.size() > 0) {
    const id = this.faces.get(0);
    const pos = this.FSDK.GetTrackerFacePosition(this.tracker, id);

    const attr = this.FSDK.GetTrackerFacialAttribute(this.tracker, id, 'Liveness');
    const raw = attr ? this.FSDK.GetValueConfidence(attr, 'Liveness') : 0;
    const live = this.updateLive(raw);

    const ext = 20, offset = 20;
    const left = pos.xc - pos.w * 0.5 - ext;
    const top  = pos.yc - pos.w * 0.5 - ext + offset;
    const size = pos.w + ext * 2;

    this.stableFrames = Math.min(this.stableFrames + 1, 10);
    const box = this.stableFrames >= this.minStableFrames ? this.smoothBox(left, top, size) : ({ left, top, size });

    this.lastFaceTs = now;

    // OVAL
    ctx.lineWidth = 4;
    const strokeColor = live.isLive ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
    ctx.strokeStyle = strokeColor;
    const cx = box.left + box.size / 2;
    const cy = box.top  + box.size / 2;
    const rx = box.size * 0.52, ry = box.size * 0.62;
    strokeEllipse(ctx, cx, cy, rx, ry);

    // Rótulo grande embaixo
    const name = this.FSDK.GetAllNames?.(this.tracker, id) || 'Desconhecido';
    const label = `${name} • ${live.score.toFixed(2)}`;
    drawLabelPill(ctx, label, box, strokeColor);

    this.lastInfo$.next({ name, liveness: live.score, detected: true });
  } else {
    if (this.lastBox && (now - this.lastFaceTs) < this.keepMs) {
      const box = this.lastBox;
      ctx.lineWidth = 4;
      const strokeColor = this.liveIsGood ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
      ctx.strokeStyle = strokeColor;

      const cx = box.left + box.size / 2;
      const cy = box.top  + box.size / 2;
      const rx = box.size * 0.52, ry = box.size * 0.62;
      strokeEllipse(ctx, cx, cy, rx, ry);

      const label = `${(this.lastInfo$.value.name) || 'Desconhecido'} • ${this.liveScore.toFixed(2)}`;
      drawLabelPill(ctx, label, box, strokeColor);
    } else {
      this.boxEma = null; this.lastBox = null; this.stableFrames = 0;
      this.lastInfo$.next({ name: 'Desconhecido', liveness: 0, detected: false });
    }
  }
}


  private async processFrame(frame: Blob) {
    if (!this.FSDK || this.tracker === -1) return;

    const arrayBuf = await frame.arrayBuffer();
    const arr = new Uint8Array(arrayBuf);
    const buf = this.FSDK._malloc(arr.length);
    try {
      this.FSDK.HEAPU8.set(arr, buf);
      const img = this.FSDK.LoadImageFromPngBuffer(buf, arr.length);
      if (img < 0) {
        this.faces = null;
        return;
      }
      this.faces = this.FSDK.FeedFrame(this.tracker, img);
      this.FSDK.FreeImage(img);
    } finally {
      this.FSDK._free(buf);
    }
  }

  // === Upload de imagem (registrar / reconhecer) ===
  private async normalizeToPngArrayBuffer(file: File): Promise<ArrayBuffer> {
    const dataURL = await fileToDataUrl(file);
    const img = await loadImage(dataURL);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const blob: Blob = await new Promise(res => canvas.toBlob(b => res(b!), 'image/png')!);
    return blob.arrayBuffer();
  }

    async registerFromFile(file: File, userName: string) {
        if (!this.FSDK || this.tracker === -1) throw new Error('Tracker não pronto');

            const png = await this.normalizeToPngArrayBuffer(file);
            const array = new Uint8Array(png);
            const buf = this.FSDK._malloc(array.length);

        try {
            this.FSDK.HEAPU8.set(array, buf);
            const img = this.FSDK.LoadImageFromPngBuffer(buf, array.length);
            if (img < 0) throw new Error('Falha ao carregar imagem');

            this.FSDK.DetectFace(img);

            // << multi-feed: tenta várias vezes o mesmo frame
            let faces = await this.feedUntilFace(img, 8, 16);
            this.FSDK.FreeImage(img);

            if (!faces || faces.size() === 0) throw new Error('Nenhum rosto detectado');

            const faceId = faces.get(0);
            this.FSDK.SetName(this.tracker, faceId, userName);
            await this.saveTracker();
            await this.updateRegisteredUserList();
            this.log(`Rosto de ${userName} registrado com sucesso.`);
        } finally {
            this.FSDK._free(buf);
        }
    }


  async recognizeFromFile(file: File): Promise<string> {
    if (!this.FSDK || this.tracker === -1) throw new Error('Tracker não pronto');
    const png = await this.normalizeToPngArrayBuffer(file);

    const array = new Uint8Array(png);
    const buf = this.FSDK._malloc(array.length);
    try {
      this.FSDK.HEAPU8.set(array, buf);
      const img = this.FSDK.LoadImageFromPngBuffer(buf, array.length);
      if (img < 0) throw new Error('Falha ao carregar imagem');

      this.FSDK.DetectFace(img);
      const faces = this.FSDK.FeedFrame(this.tracker, img);
      this.FSDK.FreeImage(img);

      if (!faces || faces.size() === 0) throw new Error('Nenhum rosto detectado');
      const name = this.FSDK.GetAllNames(this.tracker, faces.get(0)) || 'Desconhecido';
      return name;
    } finally {
      this.FSDK._free(buf);
    }
  }

  // === Registro via câmera (nome do input + face atual) ===
  async registerFromCamera(userName: string) {
    if (!this.FSDK || this.tracker === -1) throw new Error('Tracker não pronto');
    if (!this.faces || this.faces.size() === 0) throw new Error('Nenhum rosto detectado');
    const faceId = this.faces.get(0);

    const livAttr = this.FSDK.GetTrackerFacialAttribute(this.tracker, faceId, 'Liveness');
    const liveness = livAttr ? this.FSDK.GetValueConfidence(livAttr, 'Liveness') : 0;
    if (liveness < 0.6) throw new Error(`Liveness baixo (${liveness.toFixed(2)})`);

    this.FSDK.SetName(this.tracker, faceId, userName);
    await this.saveTracker();
    await this.updateRegisteredUserList();
    this.log(`Rosto de ${userName} registrado (cam).`);
  }

  async checkInOutCurrent() {
    const info = this.lastInfo$.value;
    if (!info.detected) throw new Error('Nenhum rosto detectado no quadro atual');
    if (info.liveness < 0.6) throw new Error(`Liveness baixo (${info.liveness.toFixed(2)})`);
    if (!info.name || info.name === 'Desconhecido') throw new Error('Pessoa não cadastrada');
    return `Check-in/out OK para ${info.name} (liveness ${info.liveness.toFixed(2)})`;
  }

  async clearAll() {
    if (!this.FSDK || this.tracker === -1) return;
    this.FSDK.ClearTracker(this.tracker);
    await this.clearTrackerDataFromIndexedDB();
    await this.updateRegisteredUserList();
    this.log('Todos os usuários foram removidos.');
  }

  private async saveTracker() {
    if (!this.FSDK || this.tracker === -1) return;
    try {
      // salva em arquivo temporário do FS virtual e lê em binário
      try { this.FSDK.FS.mkdir('/tmp'); } catch {}
      const tmpFile = `/tmp/tracker_${Date.now()}.dat`;
      const res = this.FSDK.SaveTrackerMemoryToFile(this.tracker, tmpFile);
      if (res !== 0) throw new Error(`SaveTrackerMemoryToFile falhou: ${res}`);
      const data: Uint8Array = this.FSDK.FS.readFile(tmpFile, { encoding: 'binary' });
      await this.saveTrackerDataToIndexedDB(data);
      try { this.FSDK.FS.unlink(tmpFile); } catch {}
      this.log('Tracker salvo em IndexedDB.');
    } catch (e: any) {
      this.log(`Erro ao salvar tracker: ${e?.message || e}`);
    }
  }

    private async updateRegisteredUserList() {
    const list: string[] = [];
    const F = this.FSDK as any;

    if (!F || this.tracker === -1) {
        this.userList$.next([]);
        return;
    }

    const getCount = this.pickF<(tracker: number) => number>(
        'GetTrackerFaceCount', 'GetTrackerFacesCount'
    );

    const getIdByIndex = this.pickF<(tracker: number, index: number) => number>(
        'GetTrackerFaceID', 'GetTrackerFaceId', 'GetTrackerFaceIDByIndex'
    );

    const getAllNames = this.pickF<(tracker: number, id: number) => string>('GetAllNames');
    const getTemplateCount = this.pickF<(tracker: number, id: number) => number>('GetFaceTemplateCount');

    if (!getCount || !getIdByIndex) {
        this.log('Aviso: este wrapper do Luxand não expõe APIs de listagem de rostos. Pulando lista.');
        this.userList$.next(['(Listagem indisponível neste build do SDK)']);
        return;
    }

    const count = getCount(this.tracker);
    for (let i = 0; i < count; i++) {
        const faceId = getIdByIndex(this.tracker, i);
        const names = getAllNames ? getAllNames(this.tracker, faceId) : '';
        const tcount = getTemplateCount ? getTemplateCount(this.tracker, faceId) : 0;
        list.push(`ID ${faceId}: ${names || 'Sem Nome'} (${tcount})`);
    }

    if (list.length === 0) list.push('Nenhum usuário registrado.');
      this.userList$.next(list);
    }

}

// Helpers locais
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}


