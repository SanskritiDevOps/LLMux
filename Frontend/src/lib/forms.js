/**
 * The API reports validation failures as "Invalid request: email: …; password: …".
 * Returns { field: message } for the fields the form has, so each error can sit under its
 * field; whatever is left over is shown as a form-level error.
 *
 * @param {import("../api/client.js").ApiError} error
 * @param {string[]} fields
 */
export function fieldErrorsFrom(error, fields) {
  const errors = {};
  if (error?.code !== "INVALID_REQUEST") return errors;
  const detail = error.message.replace(/^Invalid request: /, "");
  for (const part of detail.split("; ")) {
    const colon = part.indexOf(": ");
    const field = part.slice(0, colon);
    if (colon > 0 && fields.includes(field)) errors[field] = sentence(part.slice(colon + 2));
  }
  return errors;
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** UTF-8 length, which is what bcrypt's 72-byte password limit counts. */
export const byteLength = (value) => new TextEncoder().encode(value).length;
