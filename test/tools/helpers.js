/**
 * Shared test infrastructure for tool-level tests.
 *
 * createMockServer() — returns a minimal MCP server stub that captures
 *   registerTool() calls, plus the resulting handlers map.
 *
 * MockAnyListClient — in-memory client that owns its own state arrays.
 *   Call client.reset() (or create a fresh instance) in beforeEach.
 */

export function createMockServer() {
  const handlers = {};
  const server = {
    registerTool: (name, _schema, handler) => {
      handlers[name] = handler;
      // Return a stub registeredTool so callers can call .update() without error.
      return { update: () => {} };
    },
    // elicitation.js calls server.server.getClientCapabilities() to detect support.
    // Returning null means elicitation is disabled; missing-param paths throw instead.
    server: { getClientCapabilities: () => null },
  };
  return { server, handlers };
}

export class MockAnyListClient {
  constructor() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this.defaultListName = null;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    this._categories = [];
  }

  reset() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    this._categories = [];
  }

  async connect(listName = null) {
    const name = listName || process.env.ANYLIST_LIST_NAME || 'Test List';
    this._connected = true;
    const items = this._items;
    this.targetList = {
      name,
      identifier: 'list-123',
      items,
      getItemByName: (n) => items.find(i => i.name.toLowerCase() === n.toLowerCase()) || null,
    };
    this.client = {};
    return true;
  }

  getLists() { return this._lists; }
  getStores() { return this._stores || []; }

  async addItem(name, qty, notes, category, store = null) {
    this._items.push({ name, quantity: qty, notes, category, store });
  }

  async removeItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't check it`);
    this._items[idx].checked = true;
  }

  async uncheckItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't uncheck it`);
    this._items[idx].checked = false;
  }

  async deleteItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't delete it`);
    this._items.splice(idx, 1);
  }

  async updateItem(name, { quantity, notes } = {}) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    if (quantity !== undefined) item.quantity = quantity;
    if (notes !== undefined) item.notes = notes;
  }

  async uncheckAll() {
    this._items.forEach(i => { i.checked = false; });
  }

  async createCategory(name) {
    this._categories.push(name);
  }

  async renameCategory(oldName, newName) {
    const idx = this._categories.findIndex(c => c.toLowerCase() === oldName.toLowerCase());
    if (idx === -1) throw new Error(`Category "${oldName}" not found`);
    this._categories[idx] = newName;
  }

  async deleteCategory(name) {
    const idx = this._categories.findIndex(c => c.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Category "${name}" not found`);
    this._categories.splice(idx, 1);
  }

  async getItems(includeChecked = false, includeNotes = false, includeStore = false) {
    let items = [...this._items];
    if (!includeChecked) items = items.filter(i => !i.checked);
    return items.map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
      checked: i.checked || false,
      category: i.category || 'other',
      ...(includeNotes && i.notes ? { note: i.notes } : {}),
      ...(includeStore && i.store ? { store: i.store } : {}),
    }));
  }

  async setItemStore(name, store) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    item.store = store || null;
  }

  async getFavoriteItems() { return this._favorites; }
  async getRecentItems() { return this._recents; }

  async getRecipes(search = null) {
    let r = [...this._recipes];
    if (search) r = r.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
    return r;
  }

  async getRecipeDetails(name) {
    const r = this._recipes.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new Error(`Recipe "${name}" not found`);
    return { ...r, ingredients: r.ingredients || [], preparationSteps: r.preparationSteps || [] };
  }

  async createRecipe(opts) {
    this._recipes.push(opts);
    return { identifier: `r-${this._recipes.length}`, name: opts.name };
  }

  async updateRecipe(name, fields = {}) {
    const matches = this._recipes.filter(r => r.name && r.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) throw new Error(`Recipe "${name}" not found`);
    if (matches.length > 1) throw new Error(`Multiple recipes named "${name}" (${matches.length}) exist`);
    const r = matches[0];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) r[key] = value;
    }
    return { identifier: r.identifier, name: r.name };
  }

  async deleteRecipe(name) {
    const idx = this._recipes.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe "${name}" not found`);
    this._recipes.splice(idx, 1);
  }

  async importRecipeFromUrl(url) {
    if (!this._pendingImport) throw new Error('Could not parse recipe from URL. The site may not be supported.');
    const imp = this._pendingImport;
    this._recipes.push({ identifier: 'r-imported', name: imp.name, ...imp });
    return {
      name: imp.name,
      identifier: 'r-imported',
      ingredientCount: imp.ingredientCount || 0,
      stepCount: imp.stepCount || 0,
      source: imp.source || null,
      sourceUrl: imp.sourceUrl || url,
    };
  }

  async getMealPlanEvents() { return [...this._events]; }
  async getMealPlanLabels() { return [...this._labels]; }

  async createMealPlanEvent(opts) {
    const identifier = `e-${this._events.length + 1}`;
    this._events.push({ identifier, ...opts });
    return { identifier, date: opts.date };
  }

  async updateMealPlanEvent(eventId, fields = {}) {
    const event = this._events.find(e => e.identifier === eventId);
    if (!event) throw new Error(`Meal plan event "${eventId}" not found`);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) event[key] = value;
    }
    return { identifier: eventId, date: event.date };
  }

  async deleteMealPlanEvent(id) {
    const idx = this._events.findIndex(e => e.identifier === id);
    if (idx === -1) throw new Error(`Meal plan event "${id}" not found`);
    this._events.splice(idx, 1);
  }

  async getRecipeCollections() { return [...this._collections]; }

  async createRecipeCollection(name, recipeNames = []) {
    const c = { identifier: 'c-1', name, recipeCount: recipeNames.length, recipeNames };
    this._collections.push(c);
    return c;
  }

  // Per-recipe outcomes: [{ recipeName, error: string|null }]. Throws only if the collection is missing.
  _collection(name) {
    const c = this._collections.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`Recipe collection "${name}" not found`);
    return c;
  }

  async addRecipesToCollection(name, recipeNames) {
    const c = this._collection(name);
    return recipeNames.map(recipeName => {
      if (!this._recipes.some(r => r.name.toLowerCase() === recipeName.toLowerCase())) return { recipeName, error: `Recipe "${recipeName}" not found` };
      if (c.recipeNames.includes(recipeName)) return { recipeName, error: `already in collection "${c.name}"` };
      c.recipeNames.push(recipeName);
      c.recipeCount = c.recipeNames.length;
      return { recipeName, error: null };
    });
  }

  async removeRecipesFromCollection(name, recipeNames) {
    const c = this._collection(name);
    return recipeNames.map(recipeName => {
      const idx = c.recipeNames.indexOf(recipeName);
      if (idx === -1) return { recipeName, error: `not in collection "${c.name}"` };
      c.recipeNames.splice(idx, 1);
      c.recipeCount = c.recipeNames.length;
      return { recipeName, error: null };
    });
  }

  async deleteRecipeCollection(name) {
    const idx = this._collections.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe collection "${name}" not found`);
    this._collections.splice(idx, 1);
  }
}
