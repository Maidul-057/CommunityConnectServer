require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { validateEvent } = require("./validation/events");

const app = express();
const port = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || "community-connect";
const clientOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const issuer = process.env.BETTER_AUTH_JWT_ISSUER || "http://localhost:3000";
const audience = process.env.BETTER_AUTH_JWT_AUDIENCE || issuer;
const jwksUrl = process.env.BETTER_AUTH_JWKS_URL || new URL("/api/auth/jwks", issuer).toString();
let mongoClient;
let db;
let jwks = createRemoteJWKSet(new URL(jwksUrl));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || clientOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS."));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

function getCollection(name) {
  if (!db) throw new Error("MongoDB is not connected.");
  return db.collection(name);
}

function configureTestDependencies(database, jwksUrl) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test dependencies can only be configured in test mode.");
  db = database;
  jwks = createRemoteJWKSet(new URL(jwksUrl));
}

function serializeEvent(document, participantCount) {
  const { _id, ...event } = document;
  return {
    ...event,
    date: event.date instanceof Date ? event.date.toISOString() : event.date,
    id: String(_id),
    ...(participantCount === undefined ? {} : { participantCount }),
  };
}

function parseEventId(id) {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function parseUserId(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  return /^[a-f\d]{24}$/i.test(id) ? new ObjectId(id) : id;
}

async function checkEventOwnership(events, eventId, userId) {
  const event = await events.findOne(
    { _id: eventId },
    { projection: { creatorId: 1 } },
  );
  if (!event) return { allowed: false, status: 404, message: "Event not found." };
  if (event.creatorId !== userId) {
    return { allowed: false, status: 403, message: "You do not have permission to manage this event." };
  }
  return { allowed: true };
}

async function authenticate(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Authentication required." });

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    if (typeof payload.sub !== "string" || !payload.sub) {
      return res.status(401).json({ message: "Invalid authentication token." });
    }
    req.user = {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "",
      email: typeof payload.email === "string" ? payload.email : "",
    };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired authentication token." });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "community-connect-server" });
});

app.get("/api/events", async (req, res, next) => {
  try {
    const requestedLimit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)) {
      return res.status(400).json({ message: "Limit must be an integer between 1 and 100." });
    }

    const collection = getCollection("events");
    let query = collection.find({ date: { $gt: new Date() } }).sort({ date: 1 });
    if (requestedLimit !== undefined) query = query.limit(requestedLimit);
    const documents = await query.toArray();
    return res.json(documents.map((event) => serializeEvent(event)));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/events/recent", async (_req, res, next) => {
  try {
    const documents = await getCollection("events")
      .find({ date: { $gt: new Date() } })
      .sort({ date: 1 })
      .limit(6)
      .toArray();
    return res.json(documents.map((event) => serializeEvent(event)));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/events/:id", async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return res.status(404).json({ message: "Event not found." });

    const event = await getCollection("events").findOne({ _id: eventId });
    if (!event) return res.status(404).json({ message: "Event not found." });

    const participantCount = await getCollection("joins").countDocuments({ eventId: String(eventId) });
    return res.json(serializeEvent(event, participantCount));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/events", authenticate, async (req, res, next) => {
  try {
    const validated = validateEvent(req.body || {});
    if (validated.errors) return res.status(400).json({ message: "Please correct the event details.", errors: validated.errors });

    const event = {
      ...validated.value,
      creatorId: req.user.id,
      organizerName: req.user.name,
      organizerEmail: req.user.email,
      createdAt: new Date().toISOString(),
    };
    const result = await getCollection("events").insertOne(event);
    return res.status(201).json(serializeEvent({ ...event, _id: result.insertedId }));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/me/events", authenticate, async (req, res, next) => {
  try {
    const documents = await getCollection("events")
      .find({ creatorId: req.user.id })
      .sort({ date: 1 })
      .toArray();
    const events = await Promise.all(
      documents.map(async (event) => {
        const participantCount = await getCollection("joins").countDocuments({ eventId: String(event._id) });
        return serializeEvent(event, participantCount);
      }),
    );
    return res.json(events);
  } catch (error) {
    return next(error);
  }
});

async function updateEvent(req, res, next) {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return res.status(404).json({ message: "Event not found." });
    const ownership = await checkEventOwnership(getCollection("events"), eventId, req.user.id);
    if (!ownership.allowed) return res.status(ownership.status).json({ message: ownership.message });

    const validated = validateEvent(req.body || {});
    if (validated.errors) return res.status(400).json({ message: "Please correct the event details.", errors: validated.errors });

    const result = await getCollection("events").findOneAndUpdate(
      { _id: eventId, creatorId: req.user.id },
      { $set: validated.value },
      { returnDocument: "after" },
    );
    if (!result) return res.status(404).json({ message: "Event not found." });
    const participantCount = await getCollection("joins").countDocuments({ eventId: String(eventId) });
    return res.json(serializeEvent(result, participantCount));
  } catch (error) {
    return next(error);
  }
}

app.patch("/api/events/:id", authenticate, updateEvent);
app.put("/api/events/:id", authenticate, updateEvent);

app.delete("/api/events/:id", authenticate, async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return res.status(404).json({ message: "Event not found." });
    const ownership = await checkEventOwnership(getCollection("events"), eventId, req.user.id);
    if (!ownership.allowed) return res.status(ownership.status).json({ message: ownership.message });

    const result = await getCollection("events").deleteOne({ _id: eventId, creatorId: req.user.id });
    if (!result.deletedCount) return res.status(404).json({ message: "Event not found." });

    await getCollection("joins").deleteMany({ eventId: String(eventId) });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.post("/api/events/:id/join", authenticate, async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return res.status(404).json({ message: "Event not found." });
    const event = await getCollection("events").findOne({ _id: eventId, date: { $gt: new Date() } });
    if (!event) return res.status(404).json({ message: "Event not found." });
    if (event.creatorId === req.user.id) return res.status(400).json({ message: "You cannot join your own event." });

    const joinRecord = {
      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,
      eventId: String(eventId),
      joinedAt: new Date().toISOString(),
    };
    try {
      const result = await getCollection("joins").insertOne(joinRecord);
      return res.status(201).json({ ...joinRecord, id: String(result.insertedId) });
    } catch (error) {
      if (error && error.code === 11000) return res.status(409).json({ message: "You have already joined this event." });
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

app.get("/api/me/joins", authenticate, async (req, res, next) => {
  try {
    const documents = await getCollection("joins")
      .find({ userId: req.user.id })
      .sort({ joinedAt: -1 })
      .toArray();
    return res.json(documents.map(({ _id, ...join }) => ({ ...join, id: String(_id) })));
  } catch (error) {
    return next(error);
  }
});

async function getJoinedEvents(req, res, next) {
  try {
    const joins = await getCollection("joins").find({ userId: req.user.id }).toArray();
    const eventIds = joins.map((join) => parseEventId(join.eventId)).filter(Boolean);
    if (!eventIds.length) return res.json([]);
    const events = await getCollection("events")
      .find({ _id: { $in: eventIds } })
      .sort({ date: 1 })
      .toArray();
    return res.json(events.map((event) => serializeEvent(event)));
  } catch (error) {
    return next(error);
  }
}

app.get("/api/me/joined-events", authenticate, getJoinedEvents);
app.get("/api/joined-events", authenticate, getJoinedEvents);

app.get("/api/profile", authenticate, async (req, res, next) => {
  try {
    const userId = parseUserId(req.user.id);
    if (!userId) return res.status(404).json({ message: "Profile not found." });
    const user = await getCollection("user").findOne(
      { _id: userId },
      { projection: { name: 1, email: 1, image: 1 } },
    );
    if (!user) return res.status(404).json({ message: "Profile not found." });
    return res.json({
      id: String(user._id),
      name: user.name,
      email: user.email,
      photoUrl: user.image || undefined,
    });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/profile", authenticate, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const allowedFields = new Set(["name", "photoUrl"]);
    if (Object.keys(body).some((key) => !allowedFields.has(key))) {
      return res.status(400).json({ message: "Only name and photoUrl can be updated." });
    }

    const updates = {};
    if (Object.hasOwn(body, "name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ message: "Name must be between 2 and 80 characters." });
      }
      updates.name = name;
    }
    if (Object.hasOwn(body, "photoUrl")) {
      const photoUrl = body.photoUrl === null ? "" : body.photoUrl;
      if (typeof photoUrl !== "string" || photoUrl.length > 2048) {
        return res.status(400).json({ message: "Profile photo URL must be a valid HTTP(S) URL." });
      }
      if (photoUrl.trim()) {
        try {
          const parsedUrl = new URL(photoUrl.trim());
          if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
          updates.image = parsedUrl.toString();
        } catch {
          return res.status(400).json({ message: "Profile photo URL must be a valid HTTP(S) URL." });
        }
      } else {
        updates.image = null;
      }
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "Provide a name or photoUrl to update." });
    }

    const userId = parseUserId(req.user.id);
    if (!userId) return res.status(404).json({ message: "Profile not found." });
    const user = await getCollection("user").findOneAndUpdate(
      { _id: userId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: "after", projection: { name: 1, email: 1, image: 1 } },
    );
    if (!user) return res.status(404).json({ message: "Profile not found." });
    return res.json({
      id: String(user._id),
      name: user.name,
      email: user.email,
      photoUrl: user.image || undefined,
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error);
  if (res.headersSent) return;
  return res.status(500).json({ message: "The request could not be completed." });
});

async function startServer() {
  if (!mongoUri) throw new Error("MONGODB_URI must be configured before starting the server.");
  if (process.env.NODE_ENV === "production" && (!process.env.BETTER_AUTH_JWKS_URL
    || !process.env.BETTER_AUTH_JWT_ISSUER || !process.env.BETTER_AUTH_JWT_AUDIENCE)) {
    throw new Error("BETTER_AUTH_JWKS_URL, BETTER_AUTH_JWT_ISSUER, and BETTER_AUTH_JWT_AUDIENCE must be configured in production.");
  }

  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db(databaseName);
  await Promise.all([
    getCollection("events").createIndex({ date: 1 }),
    getCollection("events").createIndex({ creatorId: 1 }),
    getCollection("joins").createIndex({ eventId: 1, userId: 1 }, { unique: true }),
    getCollection("joins").createIndex({ userId: 1, joinedAt: -1 }),
  ]);
  await getCollection("events").updateMany(
    { date: { $type: "string" } },
    [{ $set: { date: { $dateFromString: { dateString: "$date", onError: null, onNull: null } } } }],
  );
  app.listen(port, () => {
    console.log(`Community Connect server running on port ${port}`);
  });
}

function runServer() {
  startServer().catch(async (error) => {
    console.error("Failed to start Community Connect server:", error);
    if (mongoClient) await mongoClient.close();
    process.exitCode = 1;
  });
}

if (require.main === module) runServer();

module.exports = { app, checkEventOwnership, configureTestDependencies, runServer, startServer };
