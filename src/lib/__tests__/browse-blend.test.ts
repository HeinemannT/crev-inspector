import { describe, it, expect } from 'vitest';
import { blendResults, filterTypeOptions, provenance, type BrowseFilters } from '../browse-blend';
import type { BmpObject } from '../types';

const obj = (rid: string, o: Partial<BmpObject> = {}): BmpObject =>
  ({ rid, source: 'server', discoveredAt: 0, updatedAt: 0, ...o });

const filters = (o: Partial<BrowseFilters> = {}): BrowseFilters => ({
  ceTypes: new Set(), webTypes: new Set(), source: 'all', sort: 'relevance', ...o,
});

describe('blendResults', () => {
  it('dedupes by rid, preserving live (relevance) order with cache-only appended', () => {
    const live = [obj('1', { name: 'A', type: 'Scorecard' }), obj('2', { name: 'B', type: 'CeIssue' })];
    const cache = [obj('2', { name: 'B', type: 'CeIssue' }), obj('3', { name: 'C', type: 'Task' })];
    const r = blendResults(cache, live, filters());
    expect(r.map(x => x.rid)).toEqual(['1', '2', '3']);
  });

  it('marks provenance: live-only, cache-only, and both', () => {
    const live = [obj('1'), obj('2')];
    const cache = [obj('2'), obj('3')];
    const r = blendResults(cache, live, filters());
    const byRid = Object.fromEntries(r.map(x => [x.rid, x]));
    expect([byRid['1'].inLive, byRid['1'].inCache]).toEqual([true, false]);
    expect([byRid['2'].inLive, byRid['2'].inCache]).toEqual([true, true]);
    expect([byRid['3'].inLive, byRid['3'].inCache]).toEqual([false, true]);
    expect(provenance(byRid['1'])).toBe('live');     // live-only
    expect(provenance(byRid['2'])).toBe('touched');  // both → touched
    expect(provenance(byRid['3'])).toBe('touched');  // cache-only
  });

  it('backfills businessId/template the live hit lacks from the cache copy', () => {
    const live = [obj('1', { name: 'A', type: 'CeRiskAssessment' })]; // no businessId
    const cache = [obj('1', { name: 'A', type: 'CeRiskAssessment', businessId: 'ceras.7', templateBusinessId: 'risk_tpl' })];
    const r = blendResults(cache, live, filters());
    expect(r[0]).toMatchObject({ rid: '1', businessId: 'ceras.7', templateBusinessId: 'risk_tpl', inLive: true, inCache: true });
  });

  it('type filter unions both dropdowns and is an allow-set', () => {
    const live = [obj('1', { type: 'Scorecard' }), obj('2', { type: 'CeIssue' }), obj('3', { type: 'Task' })];
    const r = blendResults([], live, filters({ ceTypes: new Set(['CeIssue']), webTypes: new Set(['Task']) }));
    expect(r.map(x => x.rid)).toEqual(['2', '3']);
  });

  it('empty type sets impose no constraint', () => {
    const live = [obj('1', { type: 'Scorecard' }), obj('2', { type: 'CeIssue' })];
    expect(blendResults([], live, filters()).length).toBe(2);
  });

  it('source filter: touched keeps only cache, workspace keeps only live', () => {
    const live = [obj('1'), obj('2')];
    const cache = [obj('2'), obj('3')];
    expect(blendResults(cache, live, filters({ source: 'touched' })).map(x => x.rid)).toEqual(['2', '3']);
    expect(blendResults(cache, live, filters({ source: 'workspace' })).map(x => x.rid)).toEqual(['1', '2']);
  });

  it('sort by name / type', () => {
    const live = [obj('1', { name: 'Charlie', type: 'Task' }), obj('2', { name: 'Alpha', type: 'Scorecard' })];
    expect(blendResults([], live, filters({ sort: 'name' })).map(x => x.name)).toEqual(['Alpha', 'Charlie']);
    expect(blendResults([], live, filters({ sort: 'type' })).map(x => x.type)).toEqual(['Scorecard', 'Task']);
  });

  it('drops entries with no rid', () => {
    const r = blendResults([obj('')], [obj('')], filters());
    expect(r).toEqual([]);
  });

  it('does not mutate its input arrays', () => {
    const live = [obj('1', { name: 'A' })];
    const cache = [obj('1', { name: 'A' })];
    const liveCopy = JSON.parse(JSON.stringify(live));
    const cacheCopy = JSON.parse(JSON.stringify(cache));
    blendResults(cache, live, filters({ sort: 'name' }));
    expect(live).toEqual(liveCopy);
    expect(cache).toEqual(cacheCopy);
  });
});

describe('filterTypeOptions', () => {
  it('case-insensitive substring; empty query returns all', () => {
    const types = ['CeIncident', 'CeIndicator', 'CeIssue', 'CeRiskAssessment'];
    expect(filterTypeOptions(types, '')).toEqual(types);
    expect(filterTypeOptions(types, 'in')).toEqual(['CeIncident', 'CeIndicator']);
    expect(filterTypeOptions(types, 'RISK')).toEqual(['CeRiskAssessment']);
    expect(filterTypeOptions(types, 'zzz')).toEqual([]);
    expect(filterTypeOptions(types, '  in  ')).toEqual(['CeIncident', 'CeIndicator']); // trimmed
  });
});
