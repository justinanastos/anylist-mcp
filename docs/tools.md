# Tool Reference

Functionality is organized into **5 domain-grouped tools**. Every domain tool takes an `action` enum plus action-specific parameters.

```json
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Milk", "quantity": 2 } }
```

---

## `health_check`

Tests the connection to AnyList and verifies access to the target list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `list_name` | string | No | List to test (defaults to configured default) |

---

## `shopping`

Manage shopping lists and items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `list_name` | string | No | Target list (defaults to configured default) |
| `name` | string | For item actions | Item name |
| `quantity` | number | No | Item quantity (add_item only, default 1) |
| `notes` | string | No | Item notes (add_item only) |
| `include_checked` | boolean | No | Include checked-off items (list_items only) |
| `include_notes` | boolean | No | Include item notes in output (list_items only) |
| `store_name` | string | No | Filter items by store (add_items, set_item_category only) |
| `category` | string | No | Category for item (add_item only) |

**Actions:**

```json
// List all shopping lists with item counts
{ "name": "shopping", "arguments": { "action": "list_lists" } }

// List items on a list, grouped by category
{ "name": "shopping", "arguments": { "action": "list_items", "list_name": "Costco", "include_notes": true } }

// Add an item
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Eggs", "quantity": 2, "notes": "organic", "store": "Costco"} }

// Check off an item (supports partial name matching)
{ "name": "shopping", "arguments": { "action": "check_item", "name": "Eggs" } }

// Uncheck a checked-off item (supports partial matching against checked items)
{ "name": "shopping", "arguments": { "action": "uncheck_item", "name": "Eggs" } }

// Delete an item permanently
{ "name": "shopping", "arguments": { "action": "delete_item", "name": "Eggs" } }

// Get favorite items for a list
{ "name": "shopping", "arguments": { "action": "get_favorites" } }

// Get recently added items for a list
{ "name": "shopping", "arguments": { "action": "get_recents" } }

// Set store for an item
{ "name": "shopping", "arguments": { "action": "set_item_store", "name": "Milk", "store_name": "Costco" } }

// Set category for an item
```

---

## `recipes`

Manage AnyList recipes. Ingredients have separate fields: `name` (only what you buy), `quantity` (amount and size), `note` (prep), and `is_heading` (a section label like "Chicken", never shoppable; its quantity and note are dropped).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `name` | string | For get, update, delete | Recipe name |
| `recipes` | array | For create | `[{ name, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings }]` |
| `new_name` | string | No | Rename the recipe (update only) |
| `search` | string | No | Filter recipes by name (list only) |
| `ingredients` | array | No | `[{ name, quantity?, note?, is_heading? }]` (update — replaces list) |
| `steps` | string[] | No | Preparation steps (update — replaces list) |
| `note` | string | No | Recipe notes (update) |
| `source_name` | string | No | Source attribution (update) |
| `source_url` | string | No | Source URL (update) |
| `prep_time` | number | No | Prep time in minutes (update) |
| `cook_time` | number | No | Cook time in minutes (update) |
| `servings` | string | No | e.g. `"4"` or `"4-6"` (update) |

**Actions:**

```json
// Browse all recipes (summaries: name, rating, times, servings)
{ "name": "recipes", "arguments": { "action": "list" } }

// Search recipes
{ "name": "recipes", "arguments": { "action": "list", "search": "chicken" } }

// Get full details — ingredients (headings print as `## Heading`) and steps
{ "name": "recipes", "arguments": { "action": "get", "name": "Chicken Tikka Masala" } }

// Create recipes in one call. Returns one line per recipe:
// "created <name> (id <id>)", "existing <name> (id <id>)" or "failed <name>: <reason>".
// A recipe whose source_url or name (ignoring case and outer spaces) already exists is skipped.
{ "name": "recipes", "arguments": {
    "action": "create",
    "recipes": [{
      "name": "Simple Pasta",
      "ingredients": [
        { "name": "Pasta", "is_heading": true },
        { "name": "spaghetti", "quantity": "1 lb" },
        { "name": "garlic cloves", "quantity": "2", "note": "minced" }
      ],
      "steps": ["Boil pasta", "Sauté garlic in oil", "Toss together"],
      "servings": "4"
    }]
} }

// Partially update a recipe — only the fields you pass change; the rest
// (identifier, note, photos, collection membership, meal-plan links) are kept.
// ingredients and steps, when provided, replace the whole array.
{ "name": "recipes", "arguments": { "action": "update", "name": "Simple Pasta", "servings": "6", "note": "Doubled the garlic" } }

// Rename a recipe in place (fails if another recipe already has the new name)
{ "name": "recipes", "arguments": { "action": "update", "name": "Simple Pasta", "new_name": "Garlic Pasta" } }

// Delete a recipe
{ "name": "recipes", "arguments": { "action": "delete", "name": "Simple Pasta" } }
```

---

## `meal_plan`

Manage the AnyList meal planning calendar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `date` | string | For create | Date in `YYYY-MM-DD` format |
| `title` | string | No | Event title (use this or `recipe_id`) |
| `recipe_id` | string | No | Link an existing recipe by ID |
| `label_id` | string | No | Meal type label ID (get from `list_labels`) |
| `details` | string | No | Additional notes |
| `event_id` | string | For delete | Event ID to delete |

**Actions:**

```json
// View all meal plan events, sorted by date
{ "name": "meal_plan", "arguments": { "action": "list_events" } }

// Get available labels (Breakfast, Lunch, Dinner, etc.) with their IDs
{ "name": "meal_plan", "arguments": { "action": "list_labels" } }

// Schedule a meal
{ "name": "meal_plan", "arguments": {
    "action": "create_event",
    "date": "2025-02-15",
    "title": "Pizza Night",
    "label_id": "<id from list_labels>"
} }

// Delete an event
{ "name": "meal_plan", "arguments": { "action": "delete_event", "event_id": "<id>" } }
```

---

## `recipe_collections`

Organize recipes into named collections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list` or `create` |
| `name` | string | For create | Collection name |
| `recipe_names` | string[] | No | Recipes to include on creation |

**Actions:**

```json
// List all collections
{ "name": "recipe_collections", "arguments": { "action": "list" } }

// Create a collection
{ "name": "recipe_collections", "arguments": {
    "action": "create",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta", "Chicken Tikka Masala"]
} }
```

---

## Typical multi-step interaction

1. **Browse recipes** — `recipes` → `list`
2. **Get details** — `recipes` → `get` with `name`
3. **Plan the meal** — `meal_plan` → `create_event` with date and title
4. **Add ingredients** — `shopping` → `add_item` for each ingredient
