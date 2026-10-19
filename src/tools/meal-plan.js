import { z } from "zod";
import { textResponse, errorResponse, runBatch } from "./helpers.js";

const eventFields = {
  title: z.string().optional().describe("Event title (use this OR recipe_id)"),
  recipe_id: z.string().optional().describe("Recipe ID to link"),
  label_id: z.string().optional().describe("Label ID for meal type; omit unless a meal was named"),
  details: z.string().optional().describe("Additional notes"),
};

export function register(server, getClient) {
  server.registerTool("meal_plan", {
    title: "Meal Plan",
    description: `Manage AnyList meal planning calendar. Actions:
- list_events: Show meal plan events (sorted by date). Optional from/to (YYYY-MM-DD, inclusive).
- list_labels: Show available labels (Breakfast, Lunch, Dinner, etc.) with IDs
- create_event: Add meal plan events. Pass events: [{date, title?, recipe_id?, label_id?, details?}]
- update_event: Change events. Pass events: [{event_id, date?, title?, recipe_id?, label_id?, details?}]. Only the fields given change.
- delete_event: Delete events. Pass event_ids: [...]
Every write returns one line per change; a failed change does not stop the others.`,
    inputSchema: {
      action: z.enum(["list_events", "list_labels", "create_event", "update_event", "delete_event"]).describe("The meal plan action to perform"),
      from: z.string().optional().describe("Only events on or after this date, YYYY-MM-DD (list_events only)"),
      to: z.string().optional().describe("Only events on or before this date, YYYY-MM-DD (list_events only)"),
      events: z.array(z.object({
        event_id: z.string().optional().describe("Event ID (update_event only)"),
        date: z.string().optional().describe("Date in YYYY-MM-DD format (required for create_event)"),
        ...eventFields,
      })).optional().describe("Events to create or update"),
      event_ids: z.array(z.string()).optional().describe("Event IDs to delete (delete_event only)"),
    }
  }, async (params) => {
    const { action, from, to, events: batch, event_ids } = params;
    try {
      const client = await getClient();
      await client.connect(null);
      switch (action) {
        case "list_events": {
          let events = await client.getMealPlanEvents();
          if (from) events = events.filter(e => e.date >= from);
          if (to) events = events.filter(e => e.date <= to);
          if (events.length === 0) return textResponse("No meal plan events found.");
          events.sort((a, b) => a.date.localeCompare(b.date));
          const list = events.map(e => {
            const parts = [`- **${e.date}**`];
            if (e.title) parts.push(e.title);
            if (e.recipeName) parts.push(`📖 ${e.recipeName}`);
            if (e.labelName) parts.push(`[${e.labelName}]`);
            if (e.details) parts.push(`— ${e.details}`);
            parts.push(`(id: ${e.identifier})`);
            return parts.join(' ');
          }).join('\n');
          return textResponse(`Meal Plan (${events.length} events):\n${list}`);
        }
        case "list_labels": {
          const labels = await client.getMealPlanLabels();
          if (labels.length === 0) return textResponse("No meal plan labels found.");
          const list = labels.map(l => `- **${l.name}** (${l.hexColor || 'no color'}) — id: ${l.identifier}`).join('\n');
          return textResponse(`Meal Plan Labels:\n${list}`);
        }
        case "create_event": {
          if (!batch || batch.length === 0) throw new Error('Action "create_event" requires a non-empty "events" array');
          return await runBatch(batch, e => e.date ?? "event", async (e) => {
            if (!e.date) throw new Error('"date" is required');
            const result = await client.createMealPlanEvent({
              date: e.date,
              title: e.title || null,
              recipeId: e.recipe_id || null,
              labelId: e.label_id || null,
              details: e.details || null,
            });
            return `created ${result.date}${e.title ? ` ${e.title}` : ""} (id ${result.identifier})`;
          });
        }
        case "update_event": {
          if (!batch || batch.length === 0) throw new Error('Action "update_event" requires a non-empty "events" array');
          return await runBatch(batch, e => e.event_id ?? "event", async (e) => {
            if (!e.event_id) throw new Error('"event_id" is required');
            await client.updateMealPlanEvent(e.event_id, {
              date: e.date,
              title: e.title,
              recipeId: e.recipe_id,
              labelId: e.label_id,
              details: e.details,
            });
            return `updated ${e.event_id}`;
          });
        }
        case "delete_event": {
          if (!event_ids || event_ids.length === 0) throw new Error('Action "delete_event" requires a non-empty "event_ids" array');
          return await runBatch(event_ids, id => id, async (id) => {
            await client.deleteMealPlanEvent(id);
            return `deleted ${id}`;
          });
        }
      }
    } catch (error) {
      return errorResponse(`Meal plan ${action} failed: ${error.message}`);
    }
  });
}
