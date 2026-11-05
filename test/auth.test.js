const assert = require("node:assert/strict");
const test = require("node:test");
const { ObjectId } = require("mongodb");
const { app, checkEventOwnership } = require("../src/server");

test("protected event creation returns 401 when no JWT is sent", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: "Authentication required." });

  const invalidTokenResponse = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer not-a-valid-jwt",
    },
    body: JSON.stringify({}),
  });
  assert.equal(invalidTokenResponse.status, 401);
  assert.deepEqual(await invalidTokenResponse.json(), { message: "Invalid or expired authentication token." });
});

test("event ownership distinguishes missing, unauthorized, and owned events", async () => {
  const eventId = new ObjectId();
  const events = {
    findOne: async ({ _id }) => _id.equals(eventId) ? { creatorId: "verified-owner" } : null,
  };

  assert.deepEqual(
    await checkEventOwnership(events, eventId, "another-user"),
    { allowed: false, status: 403, message: "You do not have permission to manage this event." },
  );
  assert.deepEqual(
    await checkEventOwnership(events, new ObjectId(), "verified-owner"),
    { allowed: false, status: 404, message: "Event not found." },
  );
  assert.deepEqual(
    await checkEventOwnership(events, eventId, "verified-owner"),
    { allowed: true },
  );
});
