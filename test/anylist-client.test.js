// Runs the real AnyListClient with only the anylist-js `client` stubbed.
// TZ must be set before any Date is made: the meal plan date bug only shows west of UTC.
process.env.TZ = 'America/New_York';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';
import AnyList from '../anylist-js/lib/index.js';

function clientWith(events, { deleteError = null } = {}) {
  const created = [];
  const deleted = [];
  const client = new AnyListClient({ username: 'u', password: 'p' });
  for (const e of events) {
    e.delete = async () => {
      if (deleteError) throw new Error(deleteError);
      deleted.push(e.identifier);
    };
  }
  client.client = {
    getMealPlanningCalendarEvents: async () => events,
    createEvent: async (obj) => {
      created.push(obj);
      return { identifier: 'new-1', save: async () => {} };
    },
  };
  return { client, created, deleted };
}

describe('AnyListClient.updateMealPlanEvent (real client)', () => {
  it('keeps the date when only the title changes, west of UTC', async () => {
    const { client, created } = clientWith([
      { identifier: 'old-1', date: new Date('2026-10-20'), title: 'Tikka' },
    ]);
    await client.updateMealPlanEvent('old-1', { title: 'Curry' });
    assert.equal(created.length, 1);
    // The recreated event is saved by anylist-js with local getters, so its local date is the day.
    const d = created[0].date;
    assert.equal(d.toISOString().slice(0, 10), '2026-10-20');
    assert.equal(d.getDate(), 20);
  });

  it('carries recipeScaleFactor and orderAddedSortIndex to the new event', async () => {
    const { client, created } = clientWith([
      { identifier: 'old-1', date: new Date('2026-10-20'), title: 'Tikka', recipeScaleFactor: 2.5, orderAddedSortIndex: 7 },
    ]);
    await client.updateMealPlanEvent('old-1', { title: 'Curry' });
    assert.equal(created[0].recipeScaleFactor, 2.5);
    assert.equal(created[0].orderAddedSortIndex, 7);
  });

  it('succeeds with a flag when the old event cannot be deleted', async () => {
    const { client } = clientWith(
      [{ identifier: 'old-1', date: new Date('2026-10-20'), title: 'Tikka' }],
      { deleteError: 'server said no' },
    );
    const result = await client.updateMealPlanEvent('old-1', { title: 'Curry' });
    assert.equal(result.identifier, 'new-1');
    assert.match(result.oldEventNotRemoved, /server said no/);
  });

  it('has no flag when the old event is deleted', async () => {
    const { client, deleted } = clientWith([{ identifier: 'old-1', date: new Date('2026-10-20'), title: 'Tikka' }]);
    const result = await client.updateMealPlanEvent('old-1', { title: 'Curry' });
    assert.deepEqual(deleted, ['old-1']);
    assert.equal(result.oldEventNotRemoved, undefined);
  });
});

describe('AnyListClient.connect (real client)', () => {
  it('leaves no half-built client when login throws', async () => {
    const realLogin = AnyList.prototype.login;
    AnyList.prototype.login = async () => { throw new Error('bad password'); };
    try {
      const client = new AnyListClient({ username: 'u', password: 'p', defaultListName: 'Groceries' });
      await assert.rejects(client.connect(), /Failed to connect to AnyList: bad password/);
      assert.equal(client.client, null);
    } finally {
      AnyList.prototype.login = realLogin;
    }
  });

  it('leaves no half-built client when the first getLists throws', async () => {
    const realLogin = AnyList.prototype.login;
    const realGetLists = AnyList.prototype.getLists;
    AnyList.prototype.login = async () => {};
    AnyList.prototype.getLists = async () => { throw new Error('timeout'); };
    try {
      const client = new AnyListClient({ username: 'u', password: 'p', defaultListName: 'Groceries' });
      await assert.rejects(client.connect(), /Failed to connect to AnyList: timeout/);
      assert.equal(client.client, null);
    } finally {
      AnyList.prototype.login = realLogin;
      AnyList.prototype.getLists = realGetLists;
    }
  });
});
