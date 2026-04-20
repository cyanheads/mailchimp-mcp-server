/**
 * @fileoverview Unit tests for the Mailchimp response-normalization helper.
 * @module tests/services/mailchimp/normalize.test
 */

import { describe, expect, it } from 'vitest';
import { normalizeMailchimp, toCamelCase } from '@/services/mailchimp/normalize.js';

describe('toCamelCase', () => {
  it('converts snake_case', () => {
    expect(toCamelCase('hard_bounce')).toBe('hardBounce');
    expect(toCamelCase('email_address')).toBe('emailAddress');
    expect(toCamelCase('last_sub_date')).toBe('lastSubDate');
  });

  it('converts kebab-case', () => {
    expect(toCamelCase('list-is-active')).toBe('listIsActive');
  });

  it('preserves all-caps merge-field tags', () => {
    expect(toCamelCase('FNAME')).toBe('FNAME');
    expect(toCamelCase('FIELD_ONE')).toBe('FIELD_ONE');
  });

  it('is a no-op for already-camelCase keys', () => {
    expect(toCamelCase('alreadyCamel')).toBe('alreadyCamel');
  });
});

describe('normalizeMailchimp', () => {
  it('passes primitives through unchanged', () => {
    expect(normalizeMailchimp(42)).toBe(42);
    expect(normalizeMailchimp('hello')).toBe('hello');
    expect(normalizeMailchimp(null)).toBeNull();
    expect(normalizeMailchimp(undefined)).toBeUndefined();
  });

  it('converts object keys to camelCase', () => {
    expect(
      normalizeMailchimp({
        email_address: 'a@b.com',
        list_id: 'abc',
        open_rate: 0.42,
      }),
    ).toEqual({ emailAddress: 'a@b.com', listId: 'abc', openRate: 0.42 });
  });

  it('strips `_links` at every depth', () => {
    const input = {
      id: 'x',
      _links: [{ href: 'https://example.com' }],
      nested: {
        _links: [{ rel: 'self' }],
        value: 1,
      },
    };
    expect(normalizeMailchimp(input)).toEqual({
      id: 'x',
      nested: { value: 1 },
    });
  });

  it('recurses into arrays of objects', () => {
    expect(
      normalizeMailchimp([
        { email_id: 'a', total_clicks: 3, _links: [{ rel: 'self' }] },
        { email_id: 'b', total_clicks: 0, _links: [] },
      ]),
    ).toEqual([
      { emailId: 'a', totalClicks: 3 },
      { emailId: 'b', totalClicks: 0 },
    ]);
  });

  it('preserves user-defined merge-field keys (FNAME, LNAME, etc.)', () => {
    expect(
      normalizeMailchimp({
        email_address: 'a@b.com',
        merge_fields: { FNAME: 'Ada', LNAME: 'Lovelace', FIELD_ONE: 'x' },
      }),
    ).toEqual({
      emailAddress: 'a@b.com',
      mergeFields: { FNAME: 'Ada', LNAME: 'Lovelace', FIELD_ONE: 'x' },
    });
  });

  it('handles deeply nested snake_case', () => {
    const input = {
      report_summary: {
        total_orders: 2,
        ecommerce: { total_revenue: 99, order_details: [{ item_id: 1 }] },
      },
    };
    expect(normalizeMailchimp(input)).toEqual({
      reportSummary: {
        totalOrders: 2,
        ecommerce: { totalRevenue: 99, orderDetails: [{ itemId: 1 }] },
      },
    });
  });
});
