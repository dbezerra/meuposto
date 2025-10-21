import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home.component';
import { CheckinComponent } from './features/checkin/checkin.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  // uma rota para cada tipo de marcação (usa param "tipo")
  { path: 'checkin/:tipo', component: CheckinComponent },
  { path: '**', redirectTo: '' }
];
