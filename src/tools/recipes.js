import { z } from "zod";
import { textResponse, errorResponse, runBatch } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

const toMinutes = (seconds) => Math.round(seconds / 60);
const toSeconds = (minutes) => Math.round(minutes * 60);

const ingredientSchema = z.object({
  name: z.string().describe("Only what you buy, e.g. 'chicken breasts'. For a heading, the section label, e.g. 'Chicken'."),
  quantity: z.string().optional().describe("Amount and size, e.g. '2 large' or '1 cup'. Ignored for headings."),
  note: z.string().optional().describe("Prep, e.g. 'butterflied and pounded to 1/2 inch'. Ignored for headings."),
  is_heading: z.boolean().optional().describe("True for a section label like 'Chicken' or 'Dressing'. Never shoppable."),
});

const recipeInputSchema = z.object({
  name: z.string().describe("Recipe name"),
  ingredients: z.array(ingredientSchema).optional(),
  steps: z.array(z.string()).optional().describe("Preparation steps in order"),
  note: z.string().optional(),
  source_name: z.string().optional(),
  source_url: z.string().optional(),
  prep_time: z.number().optional().describe("Prep time in minutes"),
  cook_time: z.number().optional().describe("Cook time in minutes"),
  servings: z.string().optional().describe("Servings, e.g. '4' or '4-6'"),
});

// A heading keeps its name only, so it can never carry a quantity or note into the grocery list.
function toIngredient(i) {
  const name = i.name.trim();
  if (i.is_heading) {
    return { name, quantity: null, note: null, isHeading: true, rawIngredient: name };
  }
  const quantity = i.quantity || null;
  const note = i.note || null;
  const base = [quantity, name].filter(Boolean).join(" ");
  return { name, quantity, note, isHeading: false, rawIngredient: note ? `${base}, ${note}` : base };
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  server.registerTool("recipes", {
    title: "Recipes",
    description: `Manage AnyList recipes. Actions:
- list: Browse recipes (returns summaries: name, rating, times, servings). Use 'search' to filter.
- get: Get full recipe details (ingredients, steps) by name
- create: Create one or more recipes. Pass recipes: [{name, ingredients, steps, ...}]. Recipes whose source_url or name already exists (ignoring case and outer spaces) are skipped and reported as existing. Returns one line per recipe.
- update: Partially update an existing recipe by name (only the fields you pass change; the rest are preserved). Pass new_name to rename it.
- delete: Delete a recipe by name

Ingredients have separate fields: name (only what you buy), quantity (amount and size), note (prep), and is_heading (a section label like "Chicken", never shoppable).`,
    inputSchema: {
      action: z.enum(["list", "get", "create", "update", "delete"]).describe("The recipe action to perform"),
      name: z.string().optional().describe("Recipe name (required for get, update, delete)"),
      new_name: z.string().optional().describe("New name for the recipe (update only)"),
      search: z.string().optional().describe("Search query to filter recipes (list only)"),
      recipes: z.array(recipeInputSchema).optional().describe("Recipes to create (create only)"),
      ingredients: z.array(ingredientSchema).optional().describe("Ingredients (update only). Replaces the entire ingredient list."),
      steps: z.array(z.string()).optional().describe("Preparation steps in order (create, update). On update, replaces the entire step list."),
      note: z.string().optional().describe("Recipe notes (update)"),
      source_name: z.string().optional().describe("Source name (update)"),
      source_url: z.string().optional().describe("Source URL (update)"),
      prep_time: z.number().optional().describe("Prep time in minutes (update)"),
      cook_time: z.number().optional().describe("Cook time in minutes (update)"),
      servings: z.string().optional().describe("Servings, e.g. '4' or '4-6' (update)"),
    }
  }, async (params) => {
    const { action, name, new_name, search, recipes: newRecipes, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const recipes = await client.getRecipes(search || null);
          if (recipes.length === 0) return textResponse(search ? `No recipes found matching "${search}".` : "No recipes found.");
          const list = recipes.map(r => {
            const parts = [`- **${r.name}**`];
            if (r.rating) parts.push(`⭐${r.rating}`);
            if (r.prepTime) parts.push(`prep: ${toMinutes(r.prepTime)}min`);
            if (r.cookTime) parts.push(`cook: ${toMinutes(r.cookTime)}min`);
            if (r.servings) parts.push(`serves: ${r.servings}`);
            parts.push(`(id: ${r.identifier})`);
            return parts.join(' | ');
          }).join('\n');
          return textResponse(`Recipes (${recipes.length}):\n${list}`);
        }
        case "get": {
          let getRecipeName = name;
          if (!getRecipeName) getRecipeName = await elicitRequiredField("name", "Which recipe would you like to view?");
          const recipe = await client.getRecipeDetails(getRecipeName);
          let text = `# ${recipe.name}\n\nID: ${recipe.identifier}\n`;
          if (recipe.sourceName) text += `Source: ${recipe.sourceName}\n`;
          if (recipe.sourceUrl) text += `URL: ${recipe.sourceUrl}\n`;
          if (recipe.rating) text += `Rating: ${'⭐'.repeat(recipe.rating)}\n`;
          if (recipe.prepTime) text += `Prep: ${toMinutes(recipe.prepTime)} min\n`;
          if (recipe.cookTime) text += `Cook: ${toMinutes(recipe.cookTime)} min\n`;
          if (recipe.servings) text += `Servings: ${recipe.servings}\n`;
          if (recipe.createdAt) text += `Created: ${recipe.createdAt}\n`;
          if (recipe.note) text += `\nNotes: ${recipe.note}\n`;
          if (recipe.ingredients.length > 0) {
            text += `\n## Ingredients\n`;
            recipe.ingredients.forEach(i => {
              text += i.isHeading
                ? `\n## ${i.name || i.rawIngredient}\n`
                : `- ${i.rawIngredient || [i.quantity, i.name, i.note].filter(Boolean).join(' ')}\n`;
            });
          }
          if (recipe.preparationSteps.length > 0) {
            text += `\n## Steps\n`;
            recipe.preparationSteps.forEach((s, idx) => { text += `${idx + 1}. ${s}\n`; });
          }
          return textResponse(text);
        }
        case "create": {
          if (!newRecipes || newRecipes.length === 0) throw new Error('Action "create" requires a non-empty "recipes" array');
          // Read the existing recipes once; recipes created in this call join the list.
          const known = (await client.getRecipes()).map(r => ({ identifier: r.identifier, name: r.name, sourceUrl: r.sourceUrl }));
          return await runBatch(newRecipes, r => r.name, async (r) => {
            const dup = known.find(k =>
              (r.source_url && k.sourceUrl && norm(k.sourceUrl) === norm(r.source_url)) ||
              norm(k.name) === norm(r.name));
            if (dup) return `existing ${dup.name} (id ${dup.identifier})`;
            const result = await client.createRecipe({
              name: r.name.trim(),
              ingredients: (r.ingredients || []).map(toIngredient),
              preparationSteps: r.steps || [],
              note: r.note || null,
              sourceName: r.source_name || null,
              sourceUrl: r.source_url || null,
              prepTime: r.prep_time ? toSeconds(r.prep_time) : null,
              cookTime: r.cook_time ? toSeconds(r.cook_time) : null,
              servings: r.servings || null,
            });
            known.push({ identifier: result.identifier, name: result.name, sourceUrl: r.source_url });
            return `created ${result.name} (id ${result.identifier})`;
          });
        }
        case "update": {
          let updateRecipeName = name;
          if (!updateRecipeName) updateRecipeName = await elicitRequiredField("name", "Which recipe would you like to update?");
          // Build a partial patch: only fields the caller actually provided.
          // ingredients/steps, when present, replace the whole array (see client.updateRecipe).
          const fields = {};
          if (new_name !== undefined) {
            if (!new_name.trim()) return errorResponse('Action "update": new_name cannot be empty.');
            fields.name = new_name;
          }
          if (ingredients !== undefined) {
            fields.ingredients = ingredients.map(toIngredient);
          }
          if (steps !== undefined) fields.preparationSteps = steps;
          if (note !== undefined) fields.note = note;
          if (source_name !== undefined) fields.sourceName = source_name;
          if (source_url !== undefined) fields.sourceUrl = source_url;
          if (prep_time !== undefined) fields.prepTime = toSeconds(prep_time);
          if (cook_time !== undefined) fields.cookTime = toSeconds(cook_time);
          if (servings !== undefined) fields.servings = servings;
          if (Object.keys(fields).length === 0) {
            return errorResponse('Action "update" requires at least one field to change (new_name, ingredients, steps, note, source_name, source_url, prep_time, cook_time, or servings).');
          }
          const updated = await client.updateRecipe(updateRecipeName, fields);
          if (fields.name !== undefined) return textResponse(`Renamed recipe "${updateRecipeName}" to "${updated.name}"`);
          return textResponse(`Updated recipe "${updated.name}"`);
        }
        case "delete": {
          let deleteRecipeName = name;
          if (!deleteRecipeName) deleteRecipeName = await elicitRequiredField("name", "Which recipe would you like to delete?");
          await client.deleteRecipe(deleteRecipeName);
          return textResponse(`Deleted recipe "${deleteRecipeName}"`);
        }
      }
    } catch (error) {
      return errorResponse(`Recipes ${action} failed: ${error.message}`);
    }
  });
}
