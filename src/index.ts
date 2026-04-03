import { Elysia } from "elysia";

const app = new Elysia()
  .get("/", () => "Everlore API")
  .get("/health", () => ({ ok: true }));

const port = Number(process.env.PORT) || 3000;
app.listen(port);

console.log(`Listening on http://localhost:${port}`);
