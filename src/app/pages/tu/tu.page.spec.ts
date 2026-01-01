import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TuPage } from './tu.page';

describe('TuPage', () => {
  let component: TuPage;
  let fixture: ComponentFixture<TuPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(TuPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
