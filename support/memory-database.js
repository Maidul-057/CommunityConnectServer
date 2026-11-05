const { ObjectId } = require("mongodb");

function sameValue(left, right) {
  if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right);
  return left === right;
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof ObjectId)) {
      if ("$gt" in expected) return actual > expected.$gt;
      if ("$in" in expected) return expected.$in.some((value) => sameValue(actual, value));
    }
    return sameValue(actual, expected);
  });
}

function createMemoryDatabase(seed = {}) {
  const collections = new Map(Object.entries(seed).map(([name, documents]) => [name, documents.map((document) => ({ ...document }))]));

  function collection(name) {
    if (!collections.has(name)) collections.set(name, []);
    const documents = collections.get(name);
    return {
      find(query = {}) {
        let result = documents.filter((document) => matches(document, query));
        const cursor = {
          sort(order) {
            const [[field, direction]] = Object.entries(order);
            result = [...result].sort((a, b) => (a[field] < b[field] ? -direction : a[field] > b[field] ? direction : 0));
            return cursor;
          },
          limit(count) { result = result.slice(0, count); return cursor; },
          async toArray() { return result.map((document) => ({ ...document })); },
        };
        return cursor;
      },
      async findOne(query) {
        const document = documents.find((item) => matches(item, query));
        return document ? { ...document } : null;
      },
      async countDocuments(query) { return documents.filter((document) => matches(document, query)).length; },
      async insertOne(document) {
        if (name === "joins" && documents.some((item) => item.eventId === document.eventId && item.userId === document.userId)) {
          const error = new Error("duplicate key");
          error.code = 11000;
          throw error;
        }
        const insertedId = new ObjectId();
        documents.push({ ...document, _id: insertedId });
        return { insertedId };
      },
      async findOneAndUpdate(query, update) {
        const document = documents.find((item) => matches(item, query));
        if (!document) return null;
        Object.assign(document, update.$set);
        return { ...document };
      },
      async deleteOne(query) {
        const index = documents.findIndex((item) => matches(item, query));
        if (index < 0) return { deletedCount: 0 };
        documents.splice(index, 1);
        return { deletedCount: 1 };
      },
      async deleteMany(query) {
        const remaining = documents.filter((item) => !matches(item, query));
        const deletedCount = documents.length - remaining.length;
        documents.splice(0, documents.length, ...remaining);
        return { deletedCount };
      },
    };
  }

  return { collection };
}

module.exports = { createMemoryDatabase };
