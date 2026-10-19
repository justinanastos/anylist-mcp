import { z } from "zod";
import { textResponse, errorResponse, runBatch } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

// Default categories recognized by anylist.
const valid_categories = ["baby","bakery","beverages","breakfast-and-cereal","condiments-oils-and-salad-dressings",
  "cooking-and-baking","dairy","frozen-foods","grains-pasta-and-side-dishes",
  "health-and-personal-care","household-and-cleaning","meat","pet-supplies",
  "produce","seafood","snacks-cookies-and-candy","soups-and-canned-goods",
  "wine-beer-spirits","other"];

  // TODO: What does this do?
function buildDescription(stores) {
  const base = `Manage AnyList shopping lists and items. Actions:
- list_lists: Show all lists with item counts
- list_items: Show items on a list (grouped by category)
- add_item: Add an item to a list
- add_items: Add several items to a list in one call (use this instead of repeating add_item)
- check_item: Check off items. Pass names: [...] (partial names match)
- uncheck_item: Uncheck checked-off items (make them active again). Pass names: [...]
- delete_item: Permanently remove items from a list. Pass names: [...]
- update_items: Change quantity and/or notes of existing items. Pass items: [{name, quantity?, notes?}]
- uncheck_all: Uncheck every item on the list
- create_category: Add custom categories. Pass categories: [{name}]
- rename_category: Rename custom categories. Pass categories: [{name, new_name}]
- delete_category: Delete custom categories. Pass categories: [{name}]
Batch actions return one line per change; a failed change does not stop the others.
- get_favorites: Get favorite items for a list
- get_recents: Get recently added items for a list
- list_stores: list stores available for the list (if any)`;
  if (!stores || stores.length === 0) return base;
  const storeList = stores.map(s => s.name).join(', ');
  return `${base}\n\nAvailable stores: ${storeList}`;
}

async function validateStoreName(client, storeName) {
  if (!storeName) return { valid: true, message: null };
  const stores = client.getStores();
  const storeNames = stores.map(s => s.name.toLowerCase());
  if (!storeNames.includes(storeName.toLowerCase())) {
    return { valid: false, message: `Store "${storeName}" not found in list "${client.targetList.name}". Available stores: ${storeNames.join(", ")}.
    Create a new store from the web application or mobile app, then try again.` };
  }
  return { valid: true, message: null };
}

function requireNames(names, action) {
  if (!names || names.length === 0) throw new Error(`Action "${action}" requires a non-empty "names" array`);
  return names;
}

function requireCategories(categories, action) {
  if (!categories || categories.length === 0) throw new Error(`Action "${action}" requires a non-empty "categories" array`);
  return categories;
}

export function register(server, getClient) {
  const { elicitListName, elicitItemChoice, elicitRequiredField } = createElicitationHelpers(server);

  function findPartialMatches(client, itemName, wantChecked = false) {
    const items = client.targetList.items || [];
    const lower = itemName.toLowerCase();
    return items
      .filter(i => Boolean(i.checked) === wantChecked && i.name.toLowerCase().includes(lower))
      .map(i => i.name);
  }

  async function resolveItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact) return exact.name;
    const matches = findPartialMatches(client, itemName);
    if (matches.length === 0) throw new Error(`Item "${itemName}" not found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  // Symmetric to resolveItemName, but resolves against checked-off items —
  // used by uncheck_item, which only makes sense on an already-checked item.
  async function resolveCheckedItemName(client, itemName) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact && exact.checked) return exact.name;
    const matches = findPartialMatches(client, itemName, true);
    if (matches.length === 0) throw new Error(`No checked-off item matching "${itemName}" found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  let lastStoreSignature = '';

  const registeredTool = server.registerTool("shopping", {
    title: "Shopping Lists & Items",
    description: buildDescription([]),
    inputSchema: {
      action: z.enum(["list_lists", "list_items", "add_item", "add_items",
        "set_item_store", "check_item", "uncheck_item", "delete_item", "update_items", "uncheck_all",
        "create_category", "rename_category", "delete_category", "get_favorites", "get_recents", "list_stores"]).describe("The shopping action to perform"),
      list_name: z.string().optional().describe("Name of the list (defaults to configured default list)"),
      name: z.string().optional().describe("Item name (required for add_item, set_item_store)"),
      names: z.array(z.string()).optional().describe("Item names (check_item, uncheck_item, delete_item)"),
      categories: z.array(z.object({
        name: z.string(),
        new_name: z.string().optional().describe("New name (rename_category only)"),
      })).optional().describe("Categories to create, rename or delete (create_category, rename_category, delete_category)"),
      items: z.array(z.union([
        z.string(),
        z.object({
          name: z.string(),
          quantity: z.union([z.number().min(1), z.string().min(1)]).optional(),
          notes: z.string().optional(),
          category: z.enum(valid_categories).optional(),
          store_name: z.string().optional(),
        })
      ])).optional().describe("Items to add (add_items) or change (update_items). Each entry is either a plain item name or an object with name/quantity/notes/category/store_name"),
      quantity: z.union([z.number().min(1), z.string().min(1)]).optional().describe("Item quantity, e.g. 2 or \"500 g\" (add_item only, defaults to 1)"),
      notes: z.string().optional().describe("Notes for the item (add_item only)"),
      include_checked: z.boolean().optional().describe("Include checked-off items (list_items only, default false)"),
      include_notes: z.boolean().optional().describe("Include notes for each item (list_items only, default false)"),
      category: z.enum(valid_categories).optional().describe("Category for the item (add_item only, defaults to 'other')"),
      store_name: z.string().optional().describe("Store to assign to this item (add_item and set_item_store only; omit or leave blank to clear)"),
    }
  }, async (params) => {
    const { action, list_name, name, quantity, notes, include_checked, include_notes, category } = params;
    if (category && !valid_categories.includes(category)) {
      throw new Error(`Invalid input for field "category": "${category}". Valid categories are: ${valid_categories.join(", ")}`);
    }
    try {
      const client = await getClient();
      switch (action) {
        case "list_lists": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const lists = client.getLists();
          if (lists.length === 0) return textResponse("No lists found in the account.");
          const output = lists.map(l => `- ${l.name} (${l.uncheckedCount} unchecked items)`).join("\n");
          return textResponse(`Available lists (${lists.length}):\n${output}`);
        }
        case "list_items": {
          let resolvedListName = list_name;
          if (!resolvedListName && !client.defaultListName) {
            await client.connect(null);
            const lists = client.getLists();
            if (lists.length > 1) {
              resolvedListName = await elicitListName(lists);
            }
          }
          await client.connect(resolvedListName);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores) });
          }
          const items = await client.getItems(include_checked || false, include_notes || false);
          if (items.length === 0) {
            return textResponse(include_checked
              ? `List "${client.targetList.name}" is empty.`
              : `No unchecked items on list "${client.targetList.name}".`);
          }
          const itemsByCategory = {};
          items.forEach(item => {
            const cat = item.category || 'other';
            if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
            itemsByCategory[cat].push(item);
          });
          const itemList = Object.keys(itemsByCategory).sort().map(category => {
            const categoryItems = itemsByCategory[category].map(item => {
              const qRaw = item.quantity == null ? "" : String(item.quantity).trim();
              const qty = (qRaw && qRaw !== "1") ? ` (${qRaw})` : "";
              const status = item.checked ? " ✓" : "";
              const note = item.note ? ` [${item.note}]` : "";
              const store = item.store ? ` @${item.store}` : "";
              return `  - ${item.name}${qty}${status}${note}${store}`;
            }).join("\n");
            return `**${category}**\n${categoryItems}`;
          }).join("\n\n");
          return textResponse(`Shopping list "${client.targetList.name}" (${items.length} items):\n${itemList}`);
        }
        case "add_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to add?");
          await client.connect(list_name);
          
          const {valid, message} = await validateStoreName(client, params.store_name);
          if (!valid)
            return errorResponse(message); 

          await client.addItem(itemName, quantity || 1, notes || null, params.category || "other", params.store_name || null);
          return textResponse(`Successfully added "${itemName}" to list "${client.targetList.name}"`);
        }
        case "add_items": {
          const entries = params.items;
          if (!entries || entries.length === 0) throw new Error(`Action "add_items" requires a non-empty "items" array`);
          await client.connect(list_name);
          const added = [];
          const failed = [];
          for (const entry of entries) {
            const item = typeof entry === "string" ? { name: entry } : entry;
            try {
              if (item.category && !valid_categories.includes(item.category)) {
                throw new Error(`invalid category "${item.category}"`);
              }
              const { valid, message } = await validateStoreName(client, item.store_name);
              if (!valid) throw new Error(message);
              await client.addItem(item.name, item.quantity || 1, item.notes || null, item.category || "other", item.store_name || null);
              added.push(item.name);
            } catch (error) {
              failed.push(`${item.name}: ${error.message}`);
            }
          }
          const summary = [`Added ${added.length} of ${entries.length} items to list "${client.targetList.name}":`];
          added.forEach(n => summary.push(`  ✓ ${n}`));
          failed.forEach(f => summary.push(`  ✗ ${f}`));
          // Same rule as every batch: an error only when nothing was added.
          return added.length === 0 ? errorResponse(summary.join("\n")) : textResponse(summary.join("\n"));
        }
        case "check_item": {
          const targets = requireNames(params.names, action);
          await client.connect(list_name);
          return await runBatch(targets, n => n, async (n) => {
            const resolved = await resolveItemName(client, n);
            await client.removeItem(resolved);
            return `checked ${resolved}`;
          });
        }
        case "uncheck_item": {
          const targets = requireNames(params.names, action);
          await client.connect(list_name);
          return await runBatch(targets, n => n, async (n) => {
            const resolved = await resolveCheckedItemName(client, n);
            await client.uncheckItem(resolved);
            return `unchecked ${resolved}`;
          });
        }
        case "delete_item": {
          const targets = requireNames(params.names, action);
          await client.connect(list_name);
          return await runBatch(targets, n => n, async (n) => {
            const resolved = await resolveItemName(client, n);
            await client.deleteItem(resolved);
            return `deleted ${resolved}`;
          });
        }
        case "update_items": {
          const entries = params.items;
          if (!entries || entries.length === 0) throw new Error(`Action "update_items" requires a non-empty "items" array`);
          await client.connect(list_name);
          return await runBatch(entries, e => (typeof e === "string" ? e : e.name), async (e) => {
            if (typeof e === "string") throw new Error("needs quantity and/or notes");
            if (e.quantity === undefined && e.notes === undefined) throw new Error("needs quantity and/or notes");
            const resolved = await resolveItemName(client, e.name);
            await client.updateItem(resolved, { quantity: e.quantity, notes: e.notes });
            return `updated ${resolved}`;
          });
        }
        case "uncheck_all": {
          await client.connect(list_name);
          await client.uncheckAll();
          return textResponse(`unchecked all items on list "${client.targetList.name}"`);
        }
        case "create_category": {
          const entries = requireCategories(params.categories, action);
          await client.connect(list_name);
          return await runBatch(entries, c => c.name, async (c) => {
            await client.createCategory(c.name);
            return `created category ${c.name}`;
          });
        }
        case "rename_category": {
          const entries = requireCategories(params.categories, action);
          await client.connect(list_name);
          return await runBatch(entries, c => c.name, async (c) => {
            if (!c.new_name) throw new Error('"new_name" is required');
            await client.renameCategory(c.name, c.new_name);
            return `renamed category ${c.name} to ${c.new_name}`;
          });
        }
        case "delete_category": {
          const entries = requireCategories(params.categories, action);
          await client.connect(list_name);
          return await runBatch(entries, c => c.name, async (c) => {
            await client.deleteCategory(c.name);
            return `deleted category ${c.name}`;
          });
        }
        case "get_favorites": {
          await client.connect(list_name || null);
          const items = await client.getFavoriteItems(list_name);
          if (items.length === 0) return textResponse(`No favorite items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Favorite items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "get_recents": {
          await client.connect(list_name || null);
          const items = await client.getRecentItems(list_name);
          if (items.length === 0) return textResponse(`No recent items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Recent items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "list_stores": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          if (stores.length === 0) return textResponse(`No stores found for list "${client.targetList.name}".`);
          const list = stores.map(s => `- ${s.name}`).join('\n');
          return textResponse(`Stores for "${client.targetList.name}" (${stores.length}):\n${list}`);
        }
      }
    } catch (error) {
      return errorResponse(`Shopping ${action} failed: ${error.message}`);
    }
  });
}
