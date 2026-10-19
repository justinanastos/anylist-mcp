import { z } from "zod";
import { textResponse, errorResponse, batchResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

export function register(server, getClient) {
  const { elicitRequiredField } = createElicitationHelpers(server);

  server.registerTool("recipe_collections", {
    title: "Recipe Collections",
    description: `Manage AnyList recipe collections. Actions:
- list: Show all collections with recipe counts and names
- create: Create a new collection, optionally with recipes
- delete: Delete a collection by name
- add_recipes: Add recipes to a collection. Pass name and recipe_names: [...]
add_recipes returns one line per recipe; a failed recipe does not stop the others.
Removing a recipe from a collection isn't supported; do that in the AnyList app.`,
    inputSchema: {
      action: z.enum(["list", "create", "delete", "add_recipes"]).describe("The collection action to perform"),
      name: z.string().optional().describe("Collection name (required for create, delete, add_recipes)"),
      recipe_names: z.array(z.string()).optional().describe("Recipe names (create, add_recipes)"),
    }
  }, async (params) => {
    const { action, name, recipe_names } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list": {
          const collections = await client.getRecipeCollections();
          if (collections.length === 0) return textResponse("No recipe collections found.");
          const list = collections.map(c => `- **${c.name}** (${c.recipeCount} recipes)${c.recipeCount > 0 ? ': ' + c.recipeNames.join(', ') : ''}`).join('\n');
          return textResponse(`Recipe Collections (${collections.length}):\n${list}`);
        }
        case "create": {
          let collectionName = name;
          if (!collectionName) collectionName = await elicitRequiredField("name", "What should the collection be called?");
          const result = await client.createRecipeCollection(collectionName, recipe_names || []);
          return textResponse(`Created recipe collection "${result.name}"`);
        }
        case "delete": {
          let deleteCollectionName = name;
          if (!deleteCollectionName) deleteCollectionName = await elicitRequiredField("name", "Which collection would you like to delete?");
          await client.deleteRecipeCollection(deleteCollectionName);
          return textResponse(`Deleted recipe collection "${deleteCollectionName}"`);
        }
        case "add_recipes": {
          if (!name) throw new Error('Action "add_recipes" requires parameter "name"');
          if (!recipe_names || recipe_names.length === 0) throw new Error('Action "add_recipes" requires a non-empty "recipe_names" array');
          const outcomes = await client.addRecipesToCollection(name, recipe_names);
          return batchResponse(outcomes.map(o => o.error
            ? { ok: false, text: `failed ${o.recipeName}: ${o.error}` }
            : { ok: true, text: `added ${o.recipeName} to ${name}` }));
        }
      }
    } catch (error) {
      return errorResponse(`Recipe collections ${action} failed: ${error.message}`);
    }
  });
}
