import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseListQuery } from './list-query.js';

const options = {
  allowedSortFields: ['name', 'createdAt'] as const,
  defaultSortField: 'name' as const,
  defaultSortDirection: 'asc' as const,
  defaultPageSize: 50,
  maxPageSize: 200,
};

test('parseListQuery activează paginarea implicit', () => {
  const query = parseListQuery({}, options);

  assert.equal(query.paginationEnabled, true);
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 50);
  assert.equal(query.skip, 0);
  assert.equal(query.take, 50);
});

test('parseListQuery aplică page/pageSize când sunt furnizate', () => {
  const query = parseListQuery(
    {
      page: '3',
      pageSize: '20',
      sort: 'createdAt:desc',
    },
    options,
  );

  assert.equal(query.paginationEnabled, true);
  assert.equal(query.page, 3);
  assert.equal(query.pageSize, 20);
  assert.equal(query.skip, 40);
  assert.equal(query.take, 20);
  assert.equal(query.sortField, 'createdAt');
  assert.equal(query.sortDirection, 'desc');
});

test('parseListQuery permite dezactivarea explicită a paginării cu paginate=false', () => {
  const query = parseListQuery(
    {
      paginate: 'false',
    },
    options,
  );

  assert.equal(query.paginationEnabled, false);
  assert.equal(query.skip, undefined);
  assert.equal(query.take, undefined);
});

test('parseListQuery permite dezactivarea explicită a paginării cu all=true', () => {
  const query = parseListQuery(
    {
      all: 'true',
    },
    options,
  );

  assert.equal(query.paginationEnabled, false);
  assert.equal(query.skip, undefined);
  assert.equal(query.take, undefined);
});

test('parseListQuery respinge page/pageSize când paginate=false', () => {
  assert.throws(
    () =>
      parseListQuery(
        {
          paginate: 'false',
          page: '2',
        },
        options,
      ),
    /page.*pageSize.*paginate=false/i,
  );
});

test('parseListQuery respinge all și paginate împreună', () => {
  assert.throws(
    () =>
      parseListQuery(
        {
          all: 'true',
          paginate: 'true',
        },
        options,
      ),
    /all.*paginate/i,
  );
});

test('parseListQuery validează parametrul paginate', () => {
  assert.throws(
    () =>
      parseListQuery(
        {
          paginate: 'nope',
        },
        options,
      ),
    /paginate.*boolean/i,
  );
});

test('parseListQuery validează parametrul all', () => {
  assert.throws(
    () =>
      parseListQuery(
        {
          all: 'xyz',
        },
        options,
      ),
    /all.*boolean/i,
  );
});
