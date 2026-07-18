const s = new Date(Date.now() + 16 * 864e5).toISOString().slice(0, 10);
const e = new Date(Date.now() + 18 * 864e5).toISOString().slice(0, 10);
const url = ;
const r = await fetch(url);
const data = await r.json();
const ra = (data.campgrounds || []).filter((c) => String(c.id).startsWith("ra-NY-"));
console.log();
for (const c of ra.slice(0, 8)) console.log();
