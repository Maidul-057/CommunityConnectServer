const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { ObjectId } = require("mongodb");
const { exportJWK, generateKeyPair, SignJWT } = require("jose");
const { createMemoryDatabase } = require("../support/memory-database");

process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_URL = "https://auth.community-connect.test";
process.env.BETTER_AUTH_JWT_ISSUER = process.env.BETTER_AUTH_URL;
process.env.BETTER_AUTH_JWT_AUDIENCE = process.env.BETTER_AUTH_URL;
const { app, configureTestDependencies } = require("../src/server");

let publicKey;
let privateKey;
let jwksServer;
let jwksUrl;
let jwksUnavailable = false;

test.before(async () => {
  ({ publicKey, privateKey } = await generateKeyPair("RS256"));
  const jwk = await exportJWK(publicKey);
  jwk.kid = "community-connect-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwksServer = http.createServer((request, response) => {
    if (jwksUnavailable) {
      response.writeHead(503).end();
      return;
    }
    if (request.url !== "/jwks") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=1" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/jwks`;
});

test.after(async () => {
  if (jwksServer) await new Promise((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
});

function validEvent(overrides = {}) {
  return {
    title: "Community park cleanup",
    description: "Join local volunteers to clean and care for our neighborhood park.",
    type: "Cleanup",
    thumbnail: "https://example.com/event.jpg",
    location: "Central Park",
    date: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

async function token(userId = new ObjectId().toHexString(), {
  expiresAt = "15m",
  name = "Test Member",
  email = "member@example.com",
  issuer = process.env.BETTER_AUTH_URL,
  audience = process.env.BETTER_AUTH_URL,
  signingKey = privateKey,
} = {}) {
  return new SignJWT({ name, email })
    .setProtectedHeader({ alg: "RS256", kid: "community-connect-test-key" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signingKey);
}

async function startApi(t, seed = {}) {
  const database = createMemoryDatabase(seed);
  configureTestDependencies(database, jwksUrl);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { database, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function authHeaders(jwt) {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
}

test("protected routes reject missing, invalid, and expired JWTs and accept a valid JWT", async (t) => {
  const { baseUrl } = await startApi(t);
  const missing = await fetch(`${baseUrl}/api/me/events`);
  assert.equal(missing.status, 401);
  const invalid = await fetch(`${baseUrl}/api/me/events`, { headers: authHeaders("not-a-jwt") });
  assert.equal(invalid.status, 401);
  const expired = await token(undefined, { expiresAt: "0s" });
  const expiredResponse = await fetch(`${baseUrl}/api/me/events`, { headers: authHeaders(expired) });
  assert.equal(expiredResponse.status, 401);
  const valid = await token();
  const accepted = await fetch(`${baseUrl}/api/me/events`, { headers: authHeaders(valid) });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), []);
});

test("protected routes reject invalid signatures, issuer, and audience", async (t) => {
  const { baseUrl } = await startApi(t);
  const wrongKey = await generateKeyPair("RS256");
  const invalidSignature = await token(undefined, { signingKey: wrongKey.privateKey });
  const wrongIssuer = await token(undefined, { issuer: "https://wrong-issuer.example" });
  const wrongAudience = await token(undefined, { audience: "wrong-community-api" });

  for (const jwt of [invalidSignature, wrongIssuer, wrongAudience]) {
    const response = await fetch(`${baseUrl}/api/me/events`, { headers: authHeaders(jwt) });
    assert.equal(response.status, 401);
  }
});

test("protected routes reject requests when the JWKS endpoint is unavailable", async (t) => {
  jwksUnavailable = true;
  t.after(() => { jwksUnavailable = false; });
  const { baseUrl } = await startApi(t);
  const jwt = await token();

  const response = await fetch(`${baseUrl}/api/me/events`, { headers: authHeaders(jwt) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: "Invalid or expired authentication token." });
});

test("event creation validates fields and derives creator identity from the verified token", async (t) => {
  const { baseUrl } = await startApi(t);
  const creatorId = new ObjectId().toHexString();
  const jwt = await token(creatorId);
  const invalid = await fetch(`${baseUrl}/api/events`, { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({}) });
  assert.equal(invalid.status, 400);
  const created = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ ...validEvent(), creatorId: "forged-id", organizerEmail: "forged@example.com" }),
  });
  assert.equal(created.status, 201);
  const event = await created.json();
  assert.equal(event.creatorId, creatorId);
  assert.equal(event.organizerEmail, "member@example.com");
});

test("upcoming events exclude past events, recent events are limited, and missing detail returns 404", async (t) => {
  const oldId = new ObjectId();
  const upcomingEvents = Array.from({ length: 8 }, (_, index) => ({
    ...validEvent({ date: new Date(Date.now() + (index + 1) * 86_400_000) }),
    _id: new ObjectId(),
  }));
  const { baseUrl } = await startApi(t, { events: [
    { ...validEvent({ date: new Date(Date.now() - 86_400_000) }), _id: oldId },
    ...upcomingEvents,
  ] });
  const upcoming = await fetch(`${baseUrl}/api/events`);
  assert.equal((await upcoming.json()).length, 8);
  const missing = await fetch(`${baseUrl}/api/events/${new ObjectId()}`);
  assert.equal(missing.status, 404);
  const recent = await fetch(`${baseUrl}/api/events/recent`);
  assert.equal((await recent.json()).length, 6);
});

test("only the creator can update or delete an event", async (t) => {
  const eventId = new ObjectId();
  const creatorId = new ObjectId().toHexString();
  const { baseUrl } = await startApi(t, { events: [{ ...validEvent(), _id: eventId, creatorId }] });
  const owner = await token(creatorId);
  const otherUser = await token();
  const updateBody = JSON.stringify(validEvent({ title: "Updated park cleanup" }));
  const forbiddenUpdate = await fetch(`${baseUrl}/api/events/${eventId}`, { method: "PATCH", headers: authHeaders(otherUser), body: updateBody });
  assert.equal(forbiddenUpdate.status, 403);
  const updated = await fetch(`${baseUrl}/api/events/${eventId}`, { method: "PATCH", headers: authHeaders(owner), body: updateBody });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).title, "Updated park cleanup");
  const forbiddenDelete = await fetch(`${baseUrl}/api/events/${eventId}`, { method: "DELETE", headers: authHeaders(otherUser) });
  assert.equal(forbiddenDelete.status, 403);
  const deleted = await fetch(`${baseUrl}/api/events/${eventId}`, { method: "DELETE", headers: authHeaders(owner) });
  assert.equal(deleted.status, 204);
});

test("join saves once, rejects duplicates and own-event joins, and isolates joined events by user", async (t) => {
  const eventId = new ObjectId();
  const ownerId = new ObjectId().toHexString();
  const attendeeId = new ObjectId().toHexString();
  const otherId = new ObjectId().toHexString();
  const pastEventId = new ObjectId();
  const { baseUrl } = await startApi(t, { events: [
    { ...validEvent({ date: new Date(Date.now() + 86_400_000) }), _id: eventId, creatorId: ownerId },
    { ...validEvent({ date: new Date(Date.now() - 86_400_000) }), _id: pastEventId, creatorId: ownerId },
  ] });
  const ownJoin = await fetch(`${baseUrl}/api/events/${eventId}/join`, { method: "POST", headers: authHeaders(await token(ownerId)) });
  assert.equal(ownJoin.status, 400);
  const pastJoin = await fetch(`${baseUrl}/api/events/${pastEventId}/join`, { method: "POST", headers: authHeaders(await token(otherId)) });
  assert.equal(pastJoin.status, 404);
  const attendeeToken = await token(attendeeId);
  const joined = await fetch(`${baseUrl}/api/events/${eventId}/join`, { method: "POST", headers: authHeaders(attendeeToken) });
  assert.equal(joined.status, 201);
  const duplicate = await fetch(`${baseUrl}/api/events/${eventId}/join`, { method: "POST", headers: authHeaders(attendeeToken) });
  assert.equal(duplicate.status, 409);
  const attendeeEvents = await fetch(`${baseUrl}/api/joined-events`, { headers: authHeaders(attendeeToken) });
  assert.equal((await attendeeEvents.json()).length, 1);
  const otherEvents = await fetch(`${baseUrl}/api/joined-events`, { headers: authHeaders(await token(otherId)) });
  assert.deepEqual(await otherEvents.json(), []);
  const unauthenticated = await fetch(`${baseUrl}/api/events/${eventId}/join`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
});

test("profile routes return and update only the authenticated user's permitted fields", async (t) => {
  const userId = new ObjectId();
  const { baseUrl } = await startApi(t, { user: [{ _id: userId, name: "Before Name", email: "profile@example.com" }] });
  const jwt = await token(userId.toHexString());
  const ownProfile = await fetch(`${baseUrl}/api/profile`, { headers: authHeaders(jwt) });
  assert.equal(ownProfile.status, 200);
  const spoofedProfile = await fetch(`${baseUrl}/api/profile?userId=${new ObjectId()}`, { headers: authHeaders(jwt) });
  assert.equal((await spoofedProfile.json()).id, userId.toHexString());
  const invalidUpdate = await fetch(`${baseUrl}/api/profile`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name: "x" }) });
  assert.equal(invalidUpdate.status, 400);
  const updated = await fetch(`${baseUrl}/api/profile`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name: "Updated Name", email: "forged@example.com" }) });
  assert.equal(updated.status, 400);
  const accepted = await fetch(`${baseUrl}/api/profile`, { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name: "Updated Name" }) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).email, "profile@example.com");
});

test("profile routes support custom string user IDs", async (t) => {
  const userId = "custom-auth-user-42";
  const { baseUrl } = await startApi(t, { user: [{ _id: userId, name: "String ID Member", email: "string-id@example.com" }] });
  const jwt = await token(userId);

  const profile = await fetch(`${baseUrl}/api/profile`, { headers: authHeaders(jwt) });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).id, userId);

  const updated = await fetch(`${baseUrl}/api/profile`, {
    method: "PATCH",
    headers: authHeaders(jwt),
    body: JSON.stringify({ name: "Updated String Member" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "Updated String Member");
});
