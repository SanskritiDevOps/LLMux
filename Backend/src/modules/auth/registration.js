import { z } from "zod";
import { GatewayError } from "../../utils/errors.js";
import { hashPassword } from "./passwords.js";

// bcrypt only uses the first 72 bytes; anything longer would be silently truncated,
// so two different long passwords could match. Limit by bytes, not characters.
const MAX_PASSWORD_BYTES = 72;

/** Emails are compared case-insensitively by storing them trimmed and lower-cased. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "must be a valid email" }));

export const PasswordSchema = z
  .string()
  .min(8, { error: "must be at least 8 characters" })
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES, {
    error: `must be at most ${MAX_PASSWORD_BYTES} bytes`,
  });

export const RegisterSchema = z.strictObject({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1, { error: "must not be empty" }).max(100),
});

/** The fields of a user that may leave the server. Never the password hash. */
export function toPublicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

/**
 * Creates an account from already-validated input.
 *
 * A taken email gets a deliberately vague message, so this endpoint cannot be used to
 * check which emails have accounts.
 *
 * @param {import("zod").infer<typeof RegisterSchema>} input
 * @param {{ users: ReturnType<typeof import("./users.repository.js").createUsersRepository> }} deps
 */
export async function registerUser({ email, password, name }, { users }) {
  const passwordHash = await hashPassword(password);
  const user = await users.create({ email, name, passwordHash });
  if (!user) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "Could not create an account with these details. If you already have one, log in instead",
    );
  }
  return toPublicUser(user);
}
