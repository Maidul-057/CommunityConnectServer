# Community Connect API

The Express API owns application data and event authorization. The Next.js App Router is the single Better Auth host and shares the configured MongoDB database with Express. Express does not expose a second auth handler; it verifies the Next.js Better Auth JWT through its JWKS endpoint and derives protected-operation identity from the verified `sub` claim.

## Local development

1. Start MongoDB and configure the same database URI/name in the client and server environments.
2. Copy `.env.example` to `.env` and set `CLIENT_URL` to the exact Next.js browser origin.
3. Set `BETTER_AUTH_JWT_ISSUER`, `BETTER_AUTH_JWT_AUDIENCE`, and `BETTER_AUTH_JWKS_URL` to match the Next.js Better Auth configuration.
4. Install and start the API:

   ```powershell
   npm install
   npm run dev
   ```

## Optional GitHub OAuth

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the **client's Next.js server environment**. Register the Better Auth callback URL:

```text
<BETTER_AUTH_URL>/api/auth/callback/github
```

For local development, that is `http://localhost:3000/api/auth/callback/github`. Do not expose provider credentials to the client bundle. Email/password registration and login remain available if GitHub credentials are not configured.

## Authentication and API behavior

- The Next.js route `src/app/api/auth/[...all]/route.ts` is the canonical Better Auth handler. Its JWT plugin provides `/api/auth/token` and `/api/auth/jwks` on the Next.js origin.
- Express loads the JWKS from `BETTER_AUTH_JWKS_URL` and verifies signature, issuer, audience, and expiry with `jose` using the configured `BETTER_AUTH_JWT_ISSUER` and `BETTER_AUTH_JWT_AUDIENCE`.
- Protected operations return `401` when the Bearer JWT is missing or invalid and `403` when an authenticated user does not own the requested event.
- Event creator identity is derived from the verified JWT subject. Event joins are stored in MongoDB with a unique event/user index.
- Public upcoming-event queries exclude past events. `/api/events/recent` sorts ascending by date and limits the MongoDB query to six.

Both processes use the same `MONGODB_URI` and `MONGODB_DB`, preserving Better Auth's user, account, session, and JWKS records without migration. The Next.js auth server persists the standard `image` field; the profile API exposes it as `photoUrl`.

## API reference

All paths are relative to the API origin. Protected endpoints require `Authorization: Bearer <JWT>` from Better Auth's `/api/auth/token` endpoint. Event request bodies use `title`, `description`, `type`, `thumbnail`, `location`, and `date`; creator identity always comes from the verified JWT.

| Method and path | Auth | Purpose and request | Success | Common errors |
| --- | --- | --- | --- | --- |
| `GET /api/health` | Public | Health check. | `200` service status. | — |
| `GET /api/events/recent` | Public | Six soonest upcoming events. | `200` event array. | `500` server error. |
| `GET /api/events?limit=N` | Public | Upcoming events, sorted by date; optional limit 1–100. | `200` event array. | `400` invalid limit; `500` server error. |
| `GET /api/events/:id` | Public | One event, including participant count. | `200` event. | `404` invalid or missing event; `500` server error. |
| `POST /api/events` | JWT | Create event with all six event fields. | `201` created event. | `400` validation errors; `401` missing/invalid JWT; `500` server error. |
| `GET /api/me/events` | JWT | Current user's hosted events. | `200` event array. | `401` missing/invalid JWT; `500` server error. |
| `PATCH /api/events/:id` | JWT + owner | Replace editable event fields using the six event fields. | `200` updated event. | `400` invalid fields; `401` unauthenticated; `403` not owner; `404` missing event; `500` server error. |
| `PUT /api/events/:id` | JWT + owner | Same update operation as PATCH. | `200` updated event. | `400`, `401`, `403`, `404`, or `500` as above. |
| `DELETE /api/events/:id` | JWT + owner | Delete hosted event and its joins. | `204` no content. | `401` unauthenticated; `403` not owner; `404` missing event; `500` server error. |
| `POST /api/events/:id/join` | JWT | Join an upcoming event; request body is not used. | `201` join record. | `401` unauthenticated; `400` own event; `404` past, invalid, or missing event; `409` duplicate join; `500` server error. |
| `GET /api/me/joins` | JWT | Current user's join records. | `200` join array. | `401` missing/invalid JWT; `500` server error. |
| `GET /api/joined-events` | JWT | Events joined by the current user, sorted by date. | `200` event array. | `401` missing/invalid JWT; `500` server error. |
| `GET /api/me/joined-events` | JWT | Alias for `/api/joined-events`. | `200` event array. | `401` missing/invalid JWT; `500` server error. |
| `GET /api/profile` | JWT | Retrieve the current user's profile. | `200` profile (`id`, `name`, `email`, optional `photoUrl`). | `401` missing/invalid JWT; `404` missing profile; `500` server error. |
| `PATCH /api/profile` | JWT | Update `name` and/or `photoUrl`; no other fields accepted. | `200` updated profile. | `400` invalid/empty update; `401` unauthenticated; `404` missing profile; `500` server error. |

Better Auth endpoints are hosted by Next.js under `/api/auth`; they are not Express endpoints. The client also provides `GET /api/auth/providers` on the Next.js origin to tell the sign-in form whether GitHub OAuth is configured.

## Deployment

Set `PORT`, `MONGODB_URI`, `MONGODB_DB`, `CLIENT_URL`, `BETTER_AUTH_JWT_ISSUER`, `BETTER_AUTH_JWT_AUDIENCE`, and `BETTER_AUTH_JWKS_URL` in the API host. `CLIENT_URL` may be a comma-separated list of exact browser origins; credentialed CORS does not allow wildcard origins. Set `NEXT_PUBLIC_API_URL` in the client build to the Express API origin. In the Next.js host, configure `MONGODB_URI`, `MONGODB_DB`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, the same JWT issuer/audience, `CLIENT_URL`, and optional GitHub credentials. Production auth cookies are secured when the Next.js `BETTER_AUTH_URL` uses HTTPS. The browser talks to auth on the Next.js origin, so the separate Express domain does not require cross-site auth cookies.

Deploy the Next.js App Router server and Express API separately or behind a proxy that routes `/api/auth/*` to Next.js and application `/api/*` requests to Express without overlapping the auth path. Do not configure Next.js as a static SPA. Keep `.env` out of source control.

## Tests

```powershell
npm test
```

The API integration suite uses an isolated in-memory collection adapter and a local test JWKS server, so it does not need production credentials or a MongoDB instance. It verifies HTTP routing and authorization behavior; it does not replace running the indexes and queries against a real isolated MongoDB test database.
