import { normalizeConfig } from "../../types/app.types";
import type { ApiRouteConfig, Handlers } from "motia";
import { z } from "zod";

export const config = normalizeConfig({
  name: "Signup",
  type: "api",
  path: "/signup",
  method: "POST",
  description: "Sign up a new user",
  flows: ["auth-flow"],
  bodySchema: z.object({
    email: z.email(),
  }),
});

export const handler: Handlers["Signup"] = async (req, { logger }) => {
  const { email } = req.body;
  logger.info("User signed up", { email });
  return { status: 201, body: { message: "User created successfully" } };
};
