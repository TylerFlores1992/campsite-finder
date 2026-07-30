import { query } from "./src/lib/db/client";
console.log(JSON.stringify(await query(process.argv.slice(2).join(" ")), null, 1));
