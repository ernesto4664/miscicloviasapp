import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GestionCallesAvenidasPage } from './gestion-calles-avenidas.page';

describe('GestionCallesAvenidasPage', () => {
  let component: GestionCallesAvenidasPage;
  let fixture: ComponentFixture<GestionCallesAvenidasPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(GestionCallesAvenidasPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
