const eventTypes = new Set([
  "Cleanup",
  "Plantation",
  "Donation",
  "Blood Donation",
  "Food Distribution",
  "Education",
  "Health Camp",
  "Workshop",
]);

function validateEvent(body) {
  const errors = {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  const thumbnail = typeof body.thumbnail === "string" ? body.thumbnail.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const date = new Date(body.date);

  if (!title || title.length > 100) errors.title = "Title is required and must be at most 100 characters.";
  if (description.length < 25 || description.length > 1200) {
    errors.description = "Description must be between 25 and 1200 characters.";
  }
  if (!eventTypes.has(type)) errors.type = "Choose a valid event type.";
  if (!location || location.length > 200) errors.location = "Location is required and must be at most 200 characters.";
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    errors.date = "Event date must be in the future.";
  }
  try {
    const imageUrl = new URL(thumbnail);
    if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error();
  } catch {
    errors.thumbnail = "A valid HTTP(S) thumbnail URL is required.";
  }

  if (Object.keys(errors).length) return { errors };
  return {
    value: {
      title,
      description,
      type,
      thumbnail,
      location,
      date,
    },
  };
}

module.exports = { validateEvent };
