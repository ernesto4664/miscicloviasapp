import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GestionCicloviasPage } from './gestion-ciclovias.page';

describe('GestionCicloviasPage', () => {
  let component: GestionCicloviasPage;
  let fixture: ComponentFixture<GestionCicloviasPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(GestionCicloviasPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
