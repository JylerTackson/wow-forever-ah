// Pulls professions -> skill tiers -> recipes (with reagents) from the Forever static namespace.
import { NS, apiGet, iconFor, pool } from "./blizzard.mjs";
import { transaction } from "./db.mjs";

const STATIC = NS.static[0]; // professions only exist in static-forever

export async function syncProfessions(db, log = console.log) {
  const index = await apiGet("/data/wow/profession/index", STATIC);
  if (!index.json) throw new Error(`profession index: HTTP ${index.status}`);
  const profs = (index.json.professions ?? []).filter((p) => !/\[DNT\]/i.test(p.name)); // skip Blizzard's internal test profession
  log(`${profs.length} professions`);

  const upsertProf = db.prepare(`
    INSERT OR REPLACE INTO professions (id, name, type, description, icon, min_skill, max_skill, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const delRecipes = db.prepare("DELETE FROM recipes WHERE profession_id = ?");
  const delReagents = db.prepare(
    "DELETE FROM recipe_reagents WHERE recipe_id IN (SELECT id FROM recipes WHERE profession_id = ?)"
  );
  const insRecipe = db.prepare(`
    INSERT OR REPLACE INTO recipes (id, profession_id, skill_tier, category, sort_order, name, description, icon,
      crafted_item_id, crafted_name, crafted_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReagent = db.prepare("INSERT OR REPLACE INTO recipe_reagents VALUES (?, ?, ?, ?)");
  const insItemName = db.prepare(
    `INSERT INTO items (item_id, name, source, fetched_at) VALUES (?, ?, 'recipe', ?)
     ON CONFLICT(item_id) DO UPDATE SET name = COALESCE(items.name, excluded.name)`
  );

  let total = 0;
  for (const p of profs) {
    const detail = (await apiGet(`/data/wow/profession/${p.id}`, STATIC)).json;
    if (!detail) continue;
    const icon = await iconFor("profession", p.id).catch(() => null);
    let minSkill = null, maxSkill = null;
    const list = []; // recipe refs with tier/category/order
    for (const t of detail.skill_tiers ?? []) {
      const tier = (await apiGet(`/data/wow/profession/${p.id}/skill-tier/${t.id}`, STATIC)).json;
      if (!tier) continue;
      minSkill = Math.min(minSkill ?? Infinity, tier.minimum_skill_level ?? Infinity);
      maxSkill = Math.max(maxSkill ?? 0, tier.maximum_skill_level ?? 0);
      for (const c of tier.categories ?? [])
        for (const r of c.recipes ?? []) list.push({ id: r.id, tier: tier.name, category: c.name, order: list.length });
    }
    // Recipe details carry the reagents and crafted item.
    const recipes = await pool(list, 8, async (ref) => {
      const [r, rIcon] = await Promise.all([
        apiGet(`/data/wow/recipe/${ref.id}`, STATIC),
        iconFor("recipe", ref.id).catch(() => null),
      ]);
      return { ref, json: r.json, icon: rIcon };
    });
    recipes.sort((a, b) => a.ref.order - b.ref.order);
    transaction(db, () => {
      upsertProf.run(p.id, detail.name, detail.type?.type ?? null, detail.description ?? null, icon,
        Number.isFinite(minSkill) ? minSkill : null, maxSkill || null, Date.now());
      delReagents.run(p.id);
      delRecipes.run(p.id);
      for (const { ref, json, icon: rIcon } of recipes) {
        if (!json) continue;
        const crafted = json.crafted_item ?? json.alliance_crafted_item ?? json.horde_crafted_item ?? null;
        insRecipe.run(json.id, p.id, ref.tier, ref.category, ref.order, json.name, json.description ?? null,
          rIcon, crafted?.id ?? null, crafted?.name ?? null, json.crafted_quantity?.value ?? json.crafted_quantity?.minimum ?? 1);
        if (crafted) insItemName.run(crafted.id, crafted.name, Date.now());
        for (const rg of json.reagents ?? []) {
          insReagent.run(json.id, rg.reagent.id, rg.reagent.name, rg.quantity);
          insItemName.run(rg.reagent.id, rg.reagent.name, Date.now());
        }
      }
    });
    total += recipes.length;
    log(`  ${detail.name}: ${recipes.length} recipes`);
  }
  return total;
}
