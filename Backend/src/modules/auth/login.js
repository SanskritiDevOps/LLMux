import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { checkPassword } from "./passwords.js";
import { EmailSchema, toPublicUser } from "./registration.js";

// No minimum length here: the rules for choosing a password belong to registration, and
// changing them must not lock existing users out. The maximum only stops huge payloads.
export const LoginSchema = z.strictObject({
  email: EmailSchema,
  password: z.string().min(1, { error: "must not be empty" }).max(1000),
});

/**
 * Checks an email and password. Unknown email and wrong password produce the same error
 * and take the same time (checkPassword hashes against a dummy), so the response reveals
 * nothing about which emails have accounts.
 *
 * @param {import("zod").infer<typeof LoginSchema>} input
 * @param {{ users: ReturnType<typeof import("./users.repository.js").createUsersRepository> }} deps
 */
export async function loginUser({ email, password }, { users }) {
  const user = await users.findByEmail(email);
  const valid = await checkPassword(password, user?.passwordHash);
  if (!valid) {
    throw new GatewayError("UNAUTHORIZED", "Invalid email or password");
  }
  return toPublicUser(user);
}
