import initWasm from "@vlcn.io/crsqlite-wasm";
import wasmUrl from "@vlcn.io/crsqlite-wasm/crsqlite.wasm?url";
import { nanoid } from 'nanoid'

const sqlite = await initWasm(() => wasmUrl);
const db = await sqlite.open(":memory:")

console.log(db);


await db.exec(`
  CREATE TABLE IF NOT EXISTS directories (
    id STRING PRIMARY KEY,
    parent_id INTEGER,
    dir_name VARCHAR(255)
  )`
);
await db.exec(`
  CREATE TABLE IF NOT EXISTS inodes (
    id STRING PRIMARY KEY,
    parent_id INTEGER,
    file_name VARCHAR(255)
  )`
);
await db.execMany([
  `SELECT crsql_as_crr('directories');`,
  `SELECT crsql_as_crr('inodes');`
])


const output = await db.exec(`pragma table_info('directories')`);
console.log(output);
await db.exec(`INSERT INTO directories VALUES (?, '0', ?)`, [
  nanoid(),
  "src"
]);

const dirs = await db.execA<[bigint, string]>("SELECT * FROM directories");
console.log(dirs)


/**
 * https://dl.acm.org/doi/pdf/10.1145/3465332.3470872
 * - inode (file metadata)
 * - directory
 * - block (file contents)
 * - (special case) - symlinks

 * Directory - Delete Wins Set: 
 * - id
 * - parent_id (root is itself?)
 * - dir_name
 * 
 * INode - :
 * - id
 * - file_name
 * - parent_id
 */