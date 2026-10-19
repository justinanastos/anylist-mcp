---
name: anylist-meal-planning
description: Use whenever Justin plans meals, puts a recipe on the meal plan, or adds or copies a recipe into AnyList, such as "plan dinners this week", "put the chicken cutlet salad on Tuesday", "copy this Paprika recipe to AnyList", "swap Tuesday and Thursday", or "what's on the meal plan". Covers how AnyList ingredients must be split into name, quantity and note, how section labels become ingredient headings, and the few-call flow from Paprika to the AnyList meal plan.
---

# Meal planning with Paprika and AnyList

Paprika is where Justin cooks. AnyList is where he shops and keeps the meal plan. A recipe lives in both. Claude copies it from Paprika into AnyList when it gets planned, and Justin fills the grocery list himself in the AnyList app.

## How does planning go?

Use as few calls as possible. Justin is usually on his phone.

1. Find each recipe in Paprika with `search_recipes`. Read each one with `get_recipe` and `include_photo: false`.
2. Call the AnyList `recipes` tool once, with `action: "create"` and every planned recipe in `recipes`. Split every ingredient by the rules below. Recipes AnyList already has come back as `existing` with their id, and the server leaves them alone.
3. Call the AnyList `meal_plan` tool once, with `action: "create_event"` and every meal in `events`. Link each one with `recipe_id` from step 2. Leave `label_id` out unless Justin names a meal, like "lunch".
4. Reply with one short line per meal: day, then recipe name.

To move or change planned meals, call `meal_plan` once with `action: "update_event"` and every change in `events`.

## How do I split an ingredient?

Each AnyList ingredient has a name, a quantity and a note. AnyList combines grocery items by name, so the name must be only the thing you buy.

| Field | Holds | Never holds |
| --- | --- | --- |
| `name` | The thing you buy: "onion", "chicken breasts" | Amounts, sizes, prep |
| `quantity` | Amount, unit and size: "1", "2 large", "1/4 cup", "2 (15 oz) cans" | Prep |
| `note` | Prep and usage: "finely chopped", "divided", "drained", "to taste" | The thing you buy |

```
"1 onion, finely chopped"
  name "onion" | quantity "1" | note "finely chopped"

"2 large chicken breasts, butterflied and pounded to 1/2 inch"
  name "chicken breasts" | quantity "2 large" | note "butterflied and pounded to 1/2 inch"

"2 (15 oz) cans black beans, drained and rinsed"
  name "black beans" | quantity "2 (15 oz) cans" | note "drained and rinsed"

"Kosher salt and black pepper"
  name "kosher salt" | note "to taste"
  name "black pepper" | note "to taste"
```

Split a line that names two things to buy into two ingredients. Keep the recipe's own words. Don't rename "scallions" to "green onions".

## How do headings work?

Headings matter to Justin. A recipe in parts must keep its parts as real AnyList headings, never as fake grocery items.

- **Ingredient sections.** A line like "Chicken:", "For the dressing", or "Dredge" becomes `{ name: "Chicken", is_heading: true }`, with no quantity and no note. Drop the trailing colon and "For the".
- **Step sections.** A step section title becomes its own step that starts with `# `, like `# Make the dressing`.
- Paprika often stores section labels as ordinary ingredient lines. Spot them by a trailing colon, "For the ...", or a line with no amount that names a part of the dish.

```
Paprika lines:            AnyList ingredients:
Chicken:                  heading "Chicken"
2 chicken breasts         chicken breasts | 2
Dressing:                 heading "Dressing"
1/2 cup mayonnaise        mayonnaise | 1/2 cup
```

## What must I never do?

- Never add ingredients to a grocery list. Justin does that in the AnyList app.
- Never update or re-copy a recipe that came back as `existing`, even if Paprika's version differs.
- Never import a recipe into AnyList from a website. A new web recipe goes into Paprika first with Paprika's `create_recipe`, then gets copied when it's planned.
- Never set a meal label Justin didn't name.
