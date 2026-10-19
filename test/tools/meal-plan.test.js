import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/meal-plan.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('meal_plan tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list_events', () => {
    it('returns empty message when no events', async () => {
      const result = await handlers.meal_plan({ action: 'list_events' });
      assert.ok(result.content[0].text.includes('No meal plan events'));
    });

    it('lists events sorted by date', async () => {
      client._events.push(
        { date: '2025-02-10', title: 'Tacos', identifier: 'e1' },
        { date: '2025-02-08', title: 'Pizza', identifier: 'e2' },
      );
      const result = await handlers.meal_plan({ action: 'list_events' });
      const t = result.content[0].text;
      assert.ok(t.indexOf('2025-02-08') < t.indexOf('2025-02-10'));
    });

    it('includes event identifier in output', async () => {
      client._events.push({ date: '2025-03-01', title: 'Sushi', identifier: 'e-abc' });
      const result = await handlers.meal_plan({ action: 'list_events' });
      assert.ok(result.content[0].text.includes('e-abc'));
    });

    it('filters events by from', async () => {
      client._events.push(
        { date: '2025-04-01', title: 'Early', identifier: 'e-early' },
        { date: '2025-04-10', title: 'Mid', identifier: 'e-mid' },
        { date: '2025-04-20', title: 'Late', identifier: 'e-late' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', from: '2025-04-10' });
      const t = result.content[0].text;
      assert.ok(!t.includes('2025-04-01'), 'event before from should be excluded');
      assert.ok(t.includes('2025-04-10'), 'event on from should be included');
      assert.ok(t.includes('2025-04-20'), 'event after from should be included');
    });

    it('filters events by to', async () => {
      client._events.push(
        { date: '2025-05-01', title: 'Early', identifier: 'f-early' },
        { date: '2025-05-10', title: 'Mid', identifier: 'f-mid' },
        { date: '2025-05-20', title: 'Late', identifier: 'f-late' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', to: '2025-05-10' });
      const t = result.content[0].text;
      assert.ok(t.includes('2025-05-01'), 'event before range end should be included');
      assert.ok(t.includes('2025-05-10'), 'event on to should be included');
      assert.ok(!t.includes('2025-05-20'), 'event after range end should be excluded');
    });

    it('filters events by from and to range', async () => {
      client._events.push(
        { date: '2025-06-01', title: 'Before', identifier: 'g-before' },
        { date: '2025-06-05', title: 'InRange', identifier: 'g-in' },
        { date: '2025-06-10', title: 'After', identifier: 'g-after' },
      );
      const result = await handlers.meal_plan({ action: 'list_events', from: '2025-06-03', to: '2025-06-07' });
      const t = result.content[0].text;
      assert.ok(!t.includes('2025-06-01'), 'event before range should be excluded');
      assert.ok(t.includes('2025-06-05'), 'event in range should be included');
      assert.ok(!t.includes('2025-06-10'), 'event after range should be excluded');
    });

    it('returns empty message when date filter excludes all events', async () => {
      client._events.push({ date: '2025-07-15', title: 'Lonely', identifier: 'h-lonely' });
      const result = await handlers.meal_plan({ action: 'list_events', from: '2025-08-01' });
      assert.ok(result.content[0].text.includes('No meal plan events'));
    });
  });

  describe('list_events range', () => {
    it('list_events filters from/to inclusive', async () => {
      client._events.push(
        { date: '2025-09-01', title: 'Before', identifier: 'a' },
        { date: '2025-09-02', title: 'First', identifier: 'b' },
        { date: '2025-09-04', title: 'Last', identifier: 'c' },
        { date: '2025-09-05', title: 'After', identifier: 'd' },
      );
      const t = (await handlers.meal_plan({ action: 'list_events', from: '2025-09-02', to: '2025-09-04' })).content[0].text;
      assert.ok(!t.includes('Before') && !t.includes('After'));
      assert.ok(t.includes('First') && t.includes('Last'));
    });
  });

  describe('list_labels', () => {
    it('returns empty message when no labels', async () => {
      const result = await handlers.meal_plan({ action: 'list_labels' });
      assert.ok(result.content[0].text.includes('No meal plan labels'));
    });

    it('lists labels with ids', async () => {
      client._labels.push({ identifier: 'l1', name: 'Dinner', hexColor: '#FF0000' });
      const result = await handlers.meal_plan({ action: 'list_labels' });
      assert.ok(result.content[0].text.includes('Dinner'));
      assert.ok(result.content[0].text.includes('l1'));
    });
  });

  describe('create_event', () => {
    it('creates an event', async () => {
      const result = await handlers.meal_plan({ action: 'create_event', events: [{ date: '2025-03-01', title: 'Pizza' }] });
      assert.equal(result.content[0].text, 'created 2025-03-01 Pizza (id e-1)');
      assert.equal(client._events.length, 1);
    });

    it('create_event adds 3 events in one call', async () => {
      const result = await handlers.meal_plan({
        action: 'create_event',
        events: [
          { date: '2025-03-01', recipe_id: 'r-1' },
          { date: '2025-03-02', recipe_id: 'r-2', label_id: 'l-dinner' },
          { date: '2025-03-03', title: 'Leftovers', details: 'finish the rice' },
        ],
      });
      assert.equal(result.content[0].text.split('\n').length, 3);
      assert.notEqual(result.isError, true);
      assert.deepEqual(client._events.map(e => e.date), ['2025-03-01', '2025-03-02', '2025-03-03']);
      assert.equal(client._events[0].recipeId, 'r-1');
      assert.equal(client._events[1].labelId, 'l-dinner');
      assert.equal(client._events[2].details, 'finish the rice');
    });

    it('create_event with no label_id stores no label', async () => {
      await handlers.meal_plan({ action: 'create_event', events: [{ date: '2025-03-01', recipe_id: 'r-1' }] });
      assert.equal(client._events[0].labelId, null);
    });

    it('reports a failed event and applies the rest', async () => {
      const real = client.createMealPlanEvent.bind(client);
      client.createMealPlanEvent = async (o) => {
        if (o.date === '2025-03-02') throw new Error('boom');
        return real(o);
      };
      const result = await handlers.meal_plan({
        action: 'create_event',
        events: [{ date: '2025-03-01', title: 'A' }, { date: '2025-03-02', title: 'B' }, { date: '2025-03-03', title: 'C' }],
      });
      assert.notEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('failed 2025-03-02: boom'));
      assert.equal(client._events.length, 2);
    });

    it('requires a non-empty events array', async () => {
      const result = await handlers.meal_plan({ action: 'create_event' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('events'));
    });
  });

  describe('update_event', () => {
    it('update_event moves a date and keeps title, recipe, label and details', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01', title: 'Tikka', recipeId: 'r-1', labelId: 'l1', details: 'extra naan' });
      const result = await handlers.meal_plan({ action: 'update_event', events: [{ event_id: 'e1', date: '2025-03-05' }] });
      assert.equal(client._events.length, 1);
      const moved = client._events[0];
      assert.equal(result.content[0].text, `updated e1 (new id ${moved.identifier})`);
      assert.deepEqual(moved, { identifier: moved.identifier, date: '2025-03-05', title: 'Tikka', recipeId: 'r-1', labelId: 'l1', details: 'extra naan' });
    });

    it('update_event gives the event a new id and the old id is no longer listed', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01', title: 'Tikka' });
      await handlers.meal_plan({ action: 'update_event', events: [{ event_id: 'e1', title: 'Curry' }] });
      assert.notEqual(client._events[0].identifier, 'e1');
      const t = (await handlers.meal_plan({ action: 'list_events' })).content[0].text;
      assert.ok(!t.includes('id: e1)'));
      assert.ok(t.includes(client._events[0].identifier));
      assert.equal(client._events[0].title, 'Curry');
    });

    it('update_event names an unknown event_id as failed while applying the rest', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01' }, { identifier: 'e2', date: '2025-03-02' });
      const result = await handlers.meal_plan({
        action: 'update_event',
        events: [{ event_id: 'e1', title: 'A' }, { event_id: 'nope', title: 'B' }, { event_id: 'e2', title: 'C' }],
      });
      assert.notEqual(result.isError, true);
      const lines = result.content[0].text.split('\n');
      assert.match(lines[0], /^updated e1 \(new id \S+\)$/);
      assert.match(lines[1], /^failed nope: .*not found/);
      assert.match(lines[2], /^updated e2 \(new id \S+\)$/);
      assert.deepEqual(client._events.map(e => e.title).sort(), ['A', 'C']);
    });

    it('is an error only when every update failed', async () => {
      const result = await handlers.meal_plan({ action: 'update_event', events: [{ event_id: 'nope', title: 'B' }] });
      assert.equal(result.isError, true);
    });
  });

  describe('delete_event', () => {
    it('delete_event removes 2 of 2', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01' }, { identifier: 'e2', date: '2025-03-02' });
      const result = await handlers.meal_plan({ action: 'delete_event', event_ids: ['e1', 'e2'] });
      assert.equal(result.content[0].text, 'deleted e1\ndeleted e2');
      assert.equal(client._events.length, 0);
    });

    it('names a bad id as failed and deletes the rest', async () => {
      client._events.push({ identifier: 'e1', date: '2025-03-01' });
      const result = await handlers.meal_plan({ action: 'delete_event', event_ids: ['bad', 'e1'] });
      assert.notEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('failed bad:'));
      assert.equal(client._events.length, 0);
    });

    it('returns error when every id is bad', async () => {
      const result = await handlers.meal_plan({ action: 'delete_event', event_ids: ['bad'] });
      assert.equal(result.isError, true);
    });
  });
});
