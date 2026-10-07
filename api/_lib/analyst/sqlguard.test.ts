import { describe, expect, it } from 'vitest';
import { limited, ROW_LIMIT, SqlRejected, validateSelect } from './sqlguard';

describe('validateSelect', () => {
  it('accepts a plain select on an allowed view', () => {
    expect(validateSelect('select vendor_name, count(*) from comparison_view group by 1;')).toBe('select vendor_name, count(*) from comparison_view group by 1');
  });
  it('accepts CTEs and joins between allowed views', () => {
    const sql = `with spread as (select line_code, max(normalized_price_inr) - min(normalized_price_inr) as d from comparison_view group by 1)
      select s.line_code, s.d, r.description from spread s join rfx_lines_view r on r.line_code = s.line_code order by s.d desc limit 3`;
    expect(validateSelect(sql)).toContain('spread');
  });
  it('accepts a literal that contains a forbidden word', () => {
    expect(() => validateSelect("select * from open_issues_view where message like '%delete%'")).not.toThrow();
  });
  it.each([
    ['delete from rfx_lines', /Only SELECT/],
    ['select 1; select 2', /Only one statement/],
    ['select * from comparison_view; drop table rfx', /Only one statement/],
    ['select * from rfx', /not available/],
    ['select * from quote_lines', /not available/],
    ['select * from pg_catalog.pg_tables', /pg_/],
    ['select * from comparison_view -- hi', /Comments/],
    ['select * from comparison_view /* x */', /Comments/],
    ['select * into newt from comparison_view', /into/],
    ['with x as (delete from rfx returning *) select * from x', /delete/],
    ['select set_config(\'a\',\'b\',false)', /pg_|system|set/],
    ['select * from comparison_view for update', /update|row locking/],
    ['select $$x$$', /Dollar/],
    ['', /empty/],
    ['explain select 1', /Only SELECT/],
    ['select * from information_schema.tables', /information_schema|not available/],
    ['select pg_sleep(10)', /pg_/],
    ['select * from "comparison_view"; select 1', /Only one statement/],
  ])('rejects %s', (sql, why) => {
    expect(() => validateSelect(sql)).toThrow(SqlRejected);
    expect(() => validateSelect(sql)).toThrow(why);
  });
  it('wraps with a row limit that allows detecting truncation', () => {
    expect(limited('select 1 from comparison_view')).toBe(`select * from (select 1 from comparison_view) as analyst_q limit ${ROW_LIMIT + 1}`);
  });
});
