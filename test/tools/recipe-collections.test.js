import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/recipe-collections.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('recipe_collections tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('list', () => {
    it('returns empty message when no collections', async () => {
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('No recipe collections'));
    });

    it('lists collections with recipe names', async () => {
      client._collections.push({ name: 'Weeknight', recipeCount: 2, recipeNames: ['Pasta', 'Salad'] });
      const result = await handlers.recipe_collections({ action: 'list' });
      assert.ok(result.content[0].text.includes('Weeknight'));
      assert.ok(result.content[0].text.includes('Pasta'));
    });
  });

  describe('create', () => {
    it('creates a collection', async () => {
      const result = await handlers.recipe_collections({ action: 'create', name: 'Quick Meals' });
      assert.ok(result.content[0].text.includes('Created recipe collection "Quick Meals"'));
    });

    it('creates collection with recipes', async () => {
      await handlers.recipe_collections({ action: 'create', name: 'Favs', recipe_names: ['Pasta'] });
      assert.equal(client._collections[client._collections.length - 1].recipeNames[0], 'Pasta');
    });
  });

  describe('add_recipes / remove_recipes', () => {
    beforeEach(() => {
      client._recipes.push({ identifier: 'r-1', name: 'Pasta' }, { identifier: 'r-2', name: 'Salad' }, { identifier: 'r-3', name: 'Soup' });
      client._collections.push({ identifier: 'c-1', name: 'Weeknight', recipeCount: 1, recipeNames: ['Soup'] });
    });

    it('add_recipes adds 2', async () => {
      const result = await handlers.recipe_collections({ action: 'add_recipes', name: 'Weeknight', recipe_names: ['Pasta', 'Salad'] });
      assert.equal(result.content[0].text, 'added Pasta to Weeknight\nadded Salad to Weeknight');
      assert.deepEqual(client._collections[0].recipeNames, ['Soup', 'Pasta', 'Salad']);
    });

    it('add_recipes names an unknown recipe as failed and adds the rest', async () => {
      const result = await handlers.recipe_collections({ action: 'add_recipes', name: 'Weeknight', recipe_names: ['Pasta', 'Ghost'] });
      assert.notEqual(result.isError, true);
      const lines = result.content[0].text.split('\n');
      assert.equal(lines[0], 'added Pasta to Weeknight');
      assert.ok(lines[1].startsWith('failed Ghost:'));
    });

    it('remove_recipes removes one', async () => {
      const result = await handlers.recipe_collections({ action: 'remove_recipes', name: 'Weeknight', recipe_names: ['Soup'] });
      assert.equal(result.content[0].text, 'removed Soup from Weeknight');
      assert.deepEqual(client._collections[0].recipeNames, []);
    });

    it('remove_recipes names a recipe not in the collection as failed', async () => {
      const result = await handlers.recipe_collections({ action: 'remove_recipes', name: 'Weeknight', recipe_names: ['Soup', 'Pasta'] });
      assert.notEqual(result.isError, true);
      const lines = result.content[0].text.split('\n');
      assert.equal(lines[0], 'removed Soup from Weeknight');
      assert.ok(lines[1].startsWith('failed Pasta:'));
      assert.ok(lines[1].includes('not in collection'));
    });

    it('is an error only when every recipe failed', async () => {
      const result = await handlers.recipe_collections({ action: 'remove_recipes', name: 'Weeknight', recipe_names: ['Pasta'] });
      assert.equal(result.isError, true);
    });

    it('is an error for an unknown collection', async () => {
      const result = await handlers.recipe_collections({ action: 'add_recipes', name: 'Nope', recipe_names: ['Pasta'] });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });

    it('requires name and recipe_names', async () => {
      const result = await handlers.recipe_collections({ action: 'add_recipes', name: 'Weeknight', recipe_names: [] });
      assert.equal(result.isError, true);
    });
  });

  describe('delete', () => {
    it('deletes an existing collection', async () => {
      client._collections.push({ name: 'Old Collection', recipeCount: 0, recipeNames: [] });
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Old Collection' });
      assert.ok(result.content[0].text.includes('Deleted recipe collection'));
      assert.equal(client._collections.length, 0);
    });

    it('returns error for non-existent collection', async () => {
      const result = await handlers.recipe_collections({ action: 'delete', name: 'Nope' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });
});
