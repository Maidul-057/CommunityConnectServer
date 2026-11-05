const assert = require("node:assert/strict");
const test = require("node:test");
const { validateEvent } = require("../src/validation/events");

function validInput() {
  return {
    title: "Community park cleanup",
    description: "Join local volunteers to clean and care for our neighborhood park.",
    type: "Cleanup",
    thumbnail: "https://example.com/event.jpg",
    location: "Central Park",
    date: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

test("accepts valid future event data and normalizes text", () => {
  const result = validateEvent({ ...validInput(), title: "  Community park cleanup  " });

  assert.equal("errors" in result, false);
  assert.equal(result.value.title, "Community park cleanup");
  assert.equal(result.value.date instanceof Date, true);
});

test("rejects past dates, unsupported event types, and unsafe image URLs", () => {
  const result = validateEvent({
    ...validInput(),
    type: "Other",
    thumbnail: "javascript:alert(1)",
    date: new Date(Date.now() - 1).toISOString(),
  });

  assert.deepEqual(Object.keys(result.errors).sort(), ["date", "thumbnail", "type"]);
});

test("rejects event fields outside the allowed lengths", () => {
  const result = validateEvent({
    ...validInput(),
    title: "",
    description: "short",
    location: "x".repeat(201),
  });

  assert.deepEqual(Object.keys(result.errors).sort(), ["description", "location", "title"]);
});
