# VINDEX backend

A small Node.js + Express API with a SQLite database, giving your car advisory site
real customer sign-up/sign-in and a persistent wishlist.

## What's in the database

- **users** — id, name, email (unique), password_hash (bcrypt), created_at
- **saved_cars** — links a user to the car IDs they've saved, so wishlists survive
  page reloads and follow the customer across devices once logged in

SQLite stores everything in one file: `data/vindex.db`. No separate database
server to install — it's created automatically the first time you run the app.

## Setup

1. Install [Node.js](https://nodejs.org) 18+ if you don't have it.
2. In this folder, install dependencies:
   ```
   npm install
   ```
3. Copy the env file and set a real secret:
   ```
   cp .env.example .env
   ```
   Open `.env` and replace `JWT_SECRET` with any long random string.
4. Start the server:
   ```
   npm start
   ```
   You should see `VINDEX backend running at http://localhost:3001`.

## API endpoints

| Method | Path                | Auth required | Body                              |
|--------|---------------------|----------------|------------------------------------|
| POST   | /api/auth/signup    | no             | `{ name, email, password }`        |
| POST   | /api/auth/login     | no             | `{ email, password }`              |
| GET    | /api/auth/me         | yes            | —                                   |
| GET    | /api/wishlist        | yes            | —                                   |
| POST   | /api/wishlist         | yes            | `{ carId }`                        |
| DELETE | /api/wishlist/:carId | yes            | —                                   |

Authenticated requests send `Authorization: Bearer <token>`, where `<token>` is
the JWT returned from signup/login.

## Connecting the frontend

`car-advisory-website.html` (in this same package) has already been updated to
call this API — signing up, signing in, and saving cars now hit these endpoints
instead of the old simulated login. Just open the HTML file in a browser while
this server is running on `http://localhost:3001`.

If you host the frontend somewhere else later, update the `API_BASE` constant
near the top of the `<script>` block in the HTML file to point at your
deployed backend URL.

## Inspecting the database

While testing, you can peek at the data with any SQLite viewer, or the CLI:
```
npx better-sqlite3-tools data/vindex.db  # or use "DB Browser for SQLite" (GUI)
```
