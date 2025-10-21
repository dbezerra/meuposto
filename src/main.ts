import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import 'webrtc-adapter';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:3000'
    })
  ]
}).catch(console.error);

// Fallback para Safari quando service worker falha
if (typeof window !== 'undefined' && !isDevMode()) {
  window.addEventListener('error', (event) => {
    if (event.message && event.message.includes('FetchEvent.respondWith')) {
      console.warn('Service worker error detected, attempting recovery...');
      // Tenta recarregar o service worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
          registrations.forEach(registration => {
            registration.unregister().then(() => {
              console.log('Service worker unregistered due to error');
              // Recarrega a página após um pequeno delay
              setTimeout(() => {
                window.location.reload();
              }, 1000);
            });
          });
        });
      }
    }
  });
}
