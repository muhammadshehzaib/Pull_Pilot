import { describe, it, expect } from 'vitest';
import { paginationMeta, parseLimit, parsePage, parsePagination } from './pagination';
import { DEFAULT_LIMIT, MAX_LIMIT } from './constants';

describe('parseLimit', () => {
  it('falls back to the default for missing, empty and unparseable values', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('banana')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('0')).toBe(DEFAULT_LIMIT);
  });

  it('clamps to [1, MAX_LIMIT]', () => {
    expect(parseLimit('99999')).toBe(MAX_LIMIT);
    expect(parseLimit('-5')).toBe(1);
    expect(parseLimit('20')).toBe(20);
  });
});

describe('parsePage', () => {
  it('defaults to page 1 for missing, empty, unparseable, zero and negative values', () => {
    for (const bad of [undefined, '', 'banana', '0', '-3', null]) {
      expect(parsePage(bad), String(bad)).toBe(1);
    }
  });

  it('keeps a valid page, including one past the end (the caller clamps)', () => {
    expect(parsePage('1')).toBe(1);
    expect(parsePage('12')).toBe(12);
  });
});

describe('parsePagination', () => {
  it('derives skip from page and limit', () => {
    expect(parsePagination({ page: '4', limit: '10' })).toEqual({
      page: 4,
      limit: 10,
      skip: 30,
    });
  });

  it('skips nothing on the default page', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0 });
  });
});

describe('paginationMeta', () => {
  it('ceils the total into pages', () => {
    expect(paginationMeta(2, 10, 45)).toEqual({
      page: 2,
      limit: 10,
      total: 45,
      totalPages: 5,
    });
  });

  it('reports at least one page so an empty list reads as "page 1 of 1"', () => {
    expect(paginationMeta(1, 50, 0).totalPages).toBe(1);
  });
});
