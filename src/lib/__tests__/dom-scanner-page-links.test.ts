/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { getAllRidElements } from '../dom-scanner';

describe('portal page-link overlay targets', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('marks location links as pages while excluding duplicate top-bar branding', () => {
    document.body.innerHTML = `
      <a class="topbar-item-link" href="/?rid=1">logo</a>
      <a class="topbar-item-link" data-test="topbar-item-link" href="/?rid=1">Organisation</a>
      <div class="page-location-element">
        <a class="nav-bar-item-content" href="/?rid=1">Current organisation</a>
        <a class="dropdown-sibling-element" href="/?rid=5">Sibling organisation</a>
      </div>
      <div class="page-location-element">
        <a class="nav-bar-item-content" href="/?rid=2">Current page</a>
        <a class="dropdown-sibling-element" href="/?rid=3">Sibling page</a>
      </div>
      <a class="ordinary-object" href="/?rid=4">Object</a>
    `;

    const targets = getAllRidElements(true);

    expect(targets.filter(target => target.rid === '1')).toHaveLength(1);
    expect(targets.find(target => target.rid === '1')).toMatchObject({
      visualType: 'Organisation', placement: 'inline-start', compact: true,
    });
    expect(targets.find(target => target.rid === '5')?.visualType).toBe('Organisation');
    expect(targets.find(target => target.rid === '2')).toMatchObject({
      visualType: 'Page', placement: 'inline-start', compact: true,
    });
    expect(targets.find(target => target.rid === '4')?.labelClassName).toBeUndefined();
  });

  it('marks top-bar personal-page entries without treating unrelated dropdown links as pages', () => {
    document.body.innerHTML = `
      <div class="topbar-placeholder-menu">
        <a class="dropdown-sibling-element" href="/?rid=10">My KPIs</a>
        <a class="dropdown-sibling-element" href="/?rid=11">My Risks</a>
      </div>
      <div class="unrelated-menu">
        <a class="dropdown-sibling-element" href="/?rid=12">Other object</a>
      </div>
    `;

    const targets = getAllRidElements(true);

    expect(targets.find(target => target.rid === '10')).toMatchObject({
      visualType: 'Page', placement: 'inline-start', compact: true,
    });
    expect(targets.find(target => target.rid === '11')?.visualType).toBe('Page');
    expect(targets.find(target => target.rid === '12')?.visualType).toBeUndefined();
  });

  it('does not guess that a lone breadcrumb group is an organisation', () => {
    document.body.innerHTML = `
      <div class="page-location-element">
        <a class="nav-bar-item-content" href="/?rid=20">Current page</a>
      </div>
    `;

    expect(getAllRidElements(true).find(target => target.rid === '20')?.visualType).toBe('Page');
  });
});
