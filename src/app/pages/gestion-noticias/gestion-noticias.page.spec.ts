import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GestionNoticiasPage } from './gestion-noticias.page';

describe('GestionNoticiasPage', () => {
  let component: GestionNoticiasPage;
  let fixture: ComponentFixture<GestionNoticiasPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(GestionNoticiasPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
