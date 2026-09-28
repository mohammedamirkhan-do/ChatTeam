import { ObjectId } from 'mongodb';
import { getDb } from './pg.js';

function fromMongo(doc) {
  if (!doc) return null;
  const out = { ...doc };
  if (out._id !== undefined) { out.id = String(out._id); delete out._id; }
  return out;
}

function fromMongoRows(docs) {
  return docs.map(fromMongo);
}

// Map `id` -> `_id` at any depth, preserving operators ($in, $ne, $or...).
// IDs are stored as plain strings (Postgres-UUID parity), never ObjectId.
function toMongo(obj) {
  if (Array.isArray(obj)) return obj.map(toMongo);
  if (obj instanceof Date) return obj;
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'id') { out._id = toMongo(v); }
      else { out[k] = toMongo(v); }
    }
    return out;
  }
  return obj;
}

function convertSort(sort) {
  if (!sort || typeof sort !== 'object') return sort;
  const out = {};
  for (const [k, v] of Object.entries(sort)) {
    out[k === 'id' ? '_id' : k] = v;
  }
  return out;
}

function convertPipeline(pipeline) {
  return (pipeline || []).map((stage) => {
    if (stage.$match) return { ...stage, $match: toMongo(stage.$match) };
    if (stage.$sort) return { ...stage, $sort: convertSort(stage.$sort) };
    if (stage.$lookup) {
      const lu = { ...stage.$lookup };
      if (lu.foreignField === 'id') lu.foreignField = '_id';
      if (lu.localField === 'id') lu.localField = '_id';
      return { ...stage, $lookup: lu };
    }
    return stage;
  });
}

export async function findOne(collection, filter) {
  const db = await getDb();
  return fromMongo(await db.collection(collection).findOne(toMongo(filter)));
}

export async function insertOne(collection, doc) {
  const db = await getDb();
  const now = new Date();
  const withDefaults = {
    created_at: now,
    updated_at: now,
    ...doc,
  };
  if (withDefaults.id === undefined || withDefaults.id === null) {
    withDefaults.id = new ObjectId().toHexString();
  }
  const stored = toMongo(withDefaults);
  await db.collection(collection).insertOne(stored);
  return fromMongo(stored);
}

export async function updateOne(collection, filter, update) {
  const db = await getDb();
  await db.collection(collection).updateOne(toMongo(filter), toMongo(update));
  return true;
}

export async function deleteOne(collection, filter) {
  const db = await getDb();
  await db.collection(collection).deleteOne(toMongo(filter));
  return true;
}

export async function find(collection, filter, options = {}) {
  const db = await getDb();
  let cursor = db.collection(collection).find(toMongo(filter));
  if (options.sort) cursor = cursor.sort(convertSort(options.sort));
  if (options.limit) cursor = cursor.limit(options.limit);
  if (options.skip) cursor = cursor.skip(options.skip);
  return fromMongoRows(await cursor.toArray());
}

export async function aggregate(collection, pipeline) {
  const db = await getDb();
  return fromMongoRows(await db.collection(collection).aggregate(convertPipeline(pipeline)).toArray());
}

export async function count(collection, filter) {
  const db = await getDb();
  return db.collection(collection).countDocuments(toMongo(filter));
}
